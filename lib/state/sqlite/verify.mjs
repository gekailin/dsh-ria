import { isDeepStrictEqual } from 'node:util'

// C3 verification. Every check here is read-only: the migrator calls it against a
// temporary DB before the DB is published, and `--verify-only` calls it against
// the authoritative one after a maintenance window.

export function checkIntegrity(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check)
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all()
  const orphanHistory = Number(db.prepare('SELECT COUNT(*) n FROM ticket_history WHERE ticket_id NOT IN (SELECT id FROM tickets)').get().n)
  const orphanMeta = Number(db.prepare("SELECT COUNT(*) n FROM schema_meta WHERE key NOT IN ('import_id','source_sha256','schema_version')").get().n)
  return {
    ok: integrity.length === 1 && integrity[0] === 'ok' && foreignKeys.length === 0 && orphanHistory === 0,
    integrity, foreignKeys, orphanHistory, extraSchemaMeta: orphanMeta,
  }
}

export function compareCounts(actual, expected) {
  const fields = ['tickets', 'history', 'hot', 'archived', 'meta']
  const mismatches = []
  for (const field of fields) {
    if (actual[field] !== expected[field]) mismatches.push({ field, expected: expected[field], actual: actual[field] })
  }
  return { ok: mismatches.length === 0, expected, actual, mismatches }
}

/**
 * Stratified, deterministic sample: archived and hot tickets, then each status,
 * are all represented before the rest of the sorted ids fill the sample. A fixed
 * sample keeps `--verify-only` reproducible and comparable across runs.
 */
export function sampleTicketIds(source, size = 20) {
  const records = source.records.slice().sort((a, b) => String(a.ticket.ticketId).localeCompare(String(b.ticket.ticketId)))
  if (records.length <= size) return records.map(record => record.ticket.ticketId)
  const buckets = new Map()
  const bucketOf = record => (record.archivedAt === null ? 'hot' : 'archived') + ':' + String(record.ticket.status || 'unknown')
  for (const record of records) {
    const key = bucketOf(record)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(record.ticket.ticketId)
  }
  const ordered = [...buckets.keys()].sort().map(key => buckets.get(key))
  const picked = new Set()
  // Round-robin over the strata first, then fill from the remaining sorted ids.
  for (let index = 0; picked.size < size && ordered.some(bucket => index < bucket.length); index += 1) {
    for (const bucket of ordered) {
      if (picked.size >= size) break
      if (index < bucket.length) picked.add(bucket[index])
    }
  }
  for (const record of records) {
    if (picked.size >= size) break
    picked.add(record.ticket.ticketId)
  }
  return [...picked].sort((a, b) => String(a).localeCompare(String(b)))
}

function diff(label, expected, actual, mismatches) {
  if (!isDeepStrictEqual(expected, actual)) mismatches.push({ field: label, expected, actual })
}

export function compareSample(adapter, source, { sampleSize = 20, history = true } = {}) {
  const ids = sampleTicketIds(source, sampleSize)
  const byId = new Map(source.records.map(record => [record.ticket.ticketId, record]))
  const results = []
  for (const id of ids) {
    const expected = byId.get(id)
    const actual = adapter.record(id)
    const mismatches = []
    if (!actual) {
      results.push({ ticketId: id, ok: false, mismatches: [{ field: 'missing', expected: true, actual: false }] })
      continue
    }
    diff('ticket', expected.ticket, actual.ticket, mismatches)
    diff('meta', expected.meta, actual.meta, mismatches)
    diff('archivedAt', expected.archivedAt, actual.archivedAt, mismatches)
    diff('archiveRecords', expected.archiveRecords || [], actual.archiveRecords || [], mismatches)
    if (history) {
      const expectedHistory = Array.isArray(expected.ticket.history) ? expected.ticket.history : []
      const actualHistory = adapter.history(id)
      diff('historyCount', expectedHistory.length, actualHistory.length, mismatches)
      diff('history', expectedHistory, actualHistory, mismatches)
    }
    results.push({ ticketId: id, ok: mismatches.length === 0, mismatches })
  }
  return { ok: results.every(result => result.ok), sampled: results.length, results }
}


export function checkDomainTables(db) {
  const exists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
  if (!exists('topics') || !exists('topic_links') || !exists('lessons')) {
    // Pre-migration databases simply have no domain tables yet; the domain
    // migration will create them. Do not fail ticket verification on that.
    return { ok: true, counts: { topics: 0, topicLinks: 0, lessons: 0 }, issues: ['domain_tables_missing'], migrated: false }
  }
  const counts = {
    topics: Number(db.prepare('SELECT COUNT(*) n FROM topics').get().n),
    topicLinks: Number(db.prepare('SELECT COUNT(*) n FROM topic_links').get().n),
    lessons: Number(db.prepare('SELECT COUNT(*) n FROM lessons').get().n),
  }
  const issues = []
  if (Number(db.prepare('SELECT COUNT(*) n FROM topic_links WHERE topic_id NOT IN (SELECT id FROM topics)').get().n)) issues.push('topic_links_orphan_topic')
  if (Number(db.prepare('SELECT COUNT(*) n FROM topic_links WHERE ticket_id NOT IN (SELECT id FROM tickets)').get().n)) issues.push('topic_links_orphan_ticket')
  if (Number(db.prepare('SELECT COUNT(*) n FROM lessons WHERE ticket_id IS NOT NULL AND ticket_id NOT IN (SELECT id FROM tickets)').get().n)) issues.push('lessons_orphan_ticket')
  if (Number(db.prepare('SELECT COUNT(*) n FROM topics WHERE archived_at IS NOT NULL AND merged_into IS NOT NULL').get().n)) issues.push('topics_archived_and_merged')
  return { ok: issues.length === 0, counts, issues }
}

export function verifyDatabase(db, adapter, source, { sampleSize = 20, requireSourceHash = true } = {}) {
  const integrity = checkIntegrity(db)
  const counts = compareCounts(adapter.counts(), source.counts)
  const sample = compareSample(adapter, source, { sampleSize })
  const importId = adapter.getSchemaMeta('import_id')
  const sourceSha256 = adapter.getSchemaMeta('source_sha256')
  const provenance = { importId, sourceSha256, expectedImportId: source.importId, expectedSourceSha256: source.sourceSha256 }
  // A live storage=sqlite DB keeps changing while ria.json is only a mirror;
  // the JSON source hash can no longer match. Offline migration keeps the
  // strict check, while --verify-only ignores only the mirror hash.
  const provenanceOk = !requireSourceHash || (importId === source.importId && sourceSha256 === source.sourceSha256)
  const domains = checkDomainTables(db)
  return {
    ok: integrity.ok && counts.ok && sample.ok && provenanceOk && domains.ok,
    integrity, counts, sample, provenance, domains,
  }
}
