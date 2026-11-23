import { isDeepStrictEqual } from 'node:util'

// C3 verification. Every check here is read-only: the migrator calls it against a
// temporary DB before the DB is published, and `--verify-only` calls it against
// the authoritative one after a maintenance window.


export function checkSelfConsistency(db) {
  const checks = []
  const issues = []
  const count = sql => Number(db.prepare(sql).get().n)
  const record = (name, actual, expected, ok, detail) => {
    checks.push({ name, actual, expected, ok, detail })
    if (!ok) issues.push('rule=' + name + ': actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected) + (detail ? ' (' + detail + ')' : ''))
  }
  const total = count('SELECT COUNT(*) n FROM tickets')
  const hot = count('SELECT COUNT(*) n FROM tickets WHERE archived_at IS NULL')
  // 0 is the legacy unarchived sentinel; archived rows carry a timestamp.
  const archived = count('SELECT COUNT(*) n FROM tickets WHERE archived_at > 0')
  record('R1_hot_plus_archived_eq_total', { hot, archived, total }, { total }, hot + archived === total, 'archived_at 0 = unarchived sentinel')
  const meta = count("SELECT COUNT(*) n FROM tickets WHERE meta IS NOT NULL AND json_valid(meta) AND json_extract(meta, '$.state') IS NOT NULL")
  record('R2_meta_state_subtree_le_hot', meta, { max: hot }, meta <= hot, 'meta.state tickets must not exceed hot')
  const history = count('SELECT COUNT(*) n FROM ticket_history')
  record('R3a_history_no_orphans', count('SELECT COUNT(*) n FROM ticket_history WHERE ticket_id NOT IN (SELECT id FROM tickets)'), { expected: 0 }, count('SELECT COUNT(*) n FROM ticket_history WHERE ticket_id NOT IN (SELECT id FROM tickets)') === 0)
  record('R3b_history_count_ge_ticket_count', history, { min: total }, history >= total)
  const orphanTopic = count('SELECT COUNT(*) n FROM topic_links WHERE topic_id NOT IN (SELECT id FROM topics)')
  record('R4a_topic_links_topic_exists', orphanTopic, { expected: 0 }, orphanTopic === 0)
  // Historical archived tickets keep their old primary link for archaeology;
  // only hot tickets must not point at an archived topic.
  const archivedPrimary = count("SELECT COUNT(*) n FROM topic_links l JOIN topics t ON t.id=l.topic_id JOIN tickets k ON k.id=l.ticket_id WHERE t.archived_at > 0 AND l.role='primary' AND k.archived_at IS NULL")
  record('R4b_archived_topic_no_hot_primary', archivedPrimary, { expected: 0 }, archivedPrimary === 0, 'hot tickets only')
  const mergedMissing = count('SELECT COUNT(*) n FROM topics WHERE merged_into IS NOT NULL AND merged_into NOT IN (SELECT id FROM topics)')
  record('R4c_merged_into_exists', mergedMissing, { expected: 0 }, mergedMissing === 0)
  const lessonsExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lessons'").get())
  if (!lessonsExists) {
    checks.push({ name: 'R5_lessons_status', actual: 'skipped', expected: 'table optional', ok: true, detail: 'lessons table missing; skipped' })
  } else {
    const lessons = count('SELECT COUNT(*) n FROM lessons')
    const blank = count("SELECT COUNT(*) n FROM lessons WHERE status IS NULL OR status=''")
    record('R5_lessons_status', { lessons, blank }, { blank: 0 }, blank === 0)
  }
  return { ok: checks.every(check => check.ok), checks, issues }
}

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
    if (expected[field] === null) continue
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
    if (source.counts.meta !== null) diff('meta', expected.meta, actual.meta, mismatches)
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
  // A merged topic is normally also archived (19 of 28 in the live state), so
  // "archived and merged" is the expected shape, not an issue. What matters is
  // that the merge target still exists.
  if (Number(db.prepare('SELECT COUNT(*) n FROM topics WHERE merged_into IS NOT NULL AND merged_into NOT IN (SELECT id FROM topics)').get().n)) issues.push('topics_merged_into_missing')
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
