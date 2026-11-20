import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../atomic-file.mjs'
import { openDatabase, transaction } from './db.mjs'

const error = (code, message) => Object.assign(new Error(message), { code })
const stamp = (now = Date.now()) => new Date(now).toISOString().replace(/[:.]/g, '-')
const json = value => JSON.stringify(value === undefined ? null : value)
const asArray = value => Array.isArray(value) ? value : []
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const asText = value => value == null ? '' : String(value)
const asInt = value => Number.isFinite(Number(value)) ? Number(value) : 0
const asNullableInt = value => Number.isFinite(Number(value)) ? Number(value) : null

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf8'))
}

function backupState({ stateDir, now }) {
  const dir = join(stateDir, 'domain-migration-' + stamp(now))
  mkdirSync(dir, { recursive: true })
  const riaPath = join(stateDir, 'ria.json')
  const lessonsPath = join(stateDir, 'lessons.json')
  const files = []
  for (const [name, path] of [['ria.json', riaPath], ['lessons.json', lessonsPath]]) {
    if (!existsSync(path)) continue
    const raw = readFileSync(path)
    writeAtomic(join(dir, name), raw)
    files.push(name)
  }
  writeAtomic(join(dir, 'manifest.json'), JSON.stringify({ tool: 'lib/state/sqlite/domain-migration.mjs', createdAt: now, files }, null, 2) + '\n')
  return { dir, files }
}

/** One-shot JSON -> SQLite import for topics, links and lessons.
 * The JSON files are only read; a timestamped backup is retained. The marker
 * in schema_meta makes a second run a verified no-op. */
export function migrateDomains({ stateDir, dbPath = join(stateDir, 'ria.sqlite'), now = Date.now(), failAfterTopics = false } = {}) {
  if (!stateDir) throw error('invalid_arguments', 'stateDir is required')
  if (!existsSync(dbPath)) throw error('sqlite_missing', 'SQLite DB is missing: ' + dbPath)
  const ria = readJson(join(stateDir, 'ria.json'), {})
  const lessonsFile = readJson(join(stateDir, 'lessons.json'), {})
  const topics = asArray(ria.topics)
  const links = asArray(ria.links)
  const lessons = Object.values(asObject(lessonsFile.entries))
  const db = openDatabase(dbPath)
  try {
    const existing = db.prepare("SELECT value FROM schema_meta WHERE key='domain_migration'").get()
    if (existing) {
      const marker = JSON.parse(existing.value)
      return { ok: true, mode: 'noop', backupDir: marker.backupDir || null,
        counts: marker.counts || { topics: 0, links: 0, lessons: 0 }, marker }
    }
    const backup = backupState({ stateDir, now })
    const ticketIds = new Set(db.prepare('SELECT id FROM tickets').all().map(row => row.id))
    const insertTopic = db.prepare(`INSERT OR REPLACE INTO topics
      (id, title, project_key, tags, brief, archived_at, merged_into, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    const insertLink = db.prepare(`INSERT OR REPLACE INTO topic_links
      (topic_id, ticket_id, role, created_at) VALUES (?,?,?,?)`)
    const insertLesson = db.prepare(`INSERT OR REPLACE INTO lessons
      (id, status, scenario, approach, pitfall, evidence, ticket_id, report_id, session_id, created_at, reviewed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    let skippedLinks = 0
    const counts = { topics: 0, links: 0, lessons: 0 }
    transaction(db, () => {
      for (const topic of topics) {
        if (!topic || !asText(topic.topicId)) continue
        insertTopic.run(asText(topic.topicId), asText(topic.title), topic.projectKey == null ? null : asText(topic.projectKey),
          json(asArray(topic.tags)), asText(topic.brief), asNullableInt(topic.archivedAt),
          topic.mergedInto == null ? null : asText(topic.mergedInto), asInt(topic.createdAt), asInt(topic.updatedAt))
        counts.topics += 1
      }
      if (failAfterTopics) throw error('domain_migration_injected_failure', 'injected failure after topics')
      for (const link of links) {
        if (!link || !asText(link.topicId) || !asText(link.ticketId)) continue
        if (!ticketIds.has(asText(link.ticketId))) { skippedLinks += 1; continue }
        insertLink.run(asText(link.topicId), asText(link.ticketId),
          link.role === 'primary' ? 'primary' : 'related', asInt(link.at))
        counts.links += 1
      }
      for (const lesson of lessons) {
        if (!lesson || !asText(lesson.id)) continue
        const source = asObject(lesson.source)
        insertLesson.run(asText(lesson.id), asText(lesson.status) || 'active',
          asText(lesson.scenario), asText(lesson.approach), asText(lesson.pitfall),
          lesson.evidence == null && lesson.sources == null ? null : json(lesson.evidence ?? lesson.sources),
          source.ticketId == null ? null : asText(source.ticketId),
          source.reportId == null ? null : asText(source.reportId),
          source.sessionId == null ? null : asText(source.sessionId),
          asInt(lesson.createdAt || lesson.updatedAt), asNullableInt(lesson.reviewedAt))
        counts.lessons += 1
      }
      const marker = { createdAt: now, backupDir: backup.dir, counts, skippedLinks,
        source: { topics: topics.length, links: links.length, lessons: lessons.length } }
      db.prepare("INSERT OR REPLACE INTO schema_meta(key,value,updated_at) VALUES('domain_migration',?,?)")
        .run(JSON.stringify(marker), now)
    })
    return { ok: true, mode: 'imported', backupDir: backup.dir, counts, skippedLinks }
  } finally { db.close() }
}
