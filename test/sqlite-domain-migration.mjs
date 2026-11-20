import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateDomains } from '../lib/state/sqlite/domain-migration.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../lib/state/sqlite/adapter.mjs'
import { verifySqliteState } from '../scripts/sqlite-verify.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-domain-migration-'))
const ticket = { ticketId: 't1', status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'g', acceptance: 'a', revision: 1, createdAt: 100, updatedAt: 100, attempt: { legacy: true }, failure: null, resolution: null, history: [] }
try {
  const dir = join(root, 'happy')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ria.json'), JSON.stringify({
    schemaVersion: 5, tickets: [ticket], topics: [{ topicId: 'topic_a', title: 'A', projectKey: null, tags: ['x'], brief: 'b', createdAt: 1, updatedAt: 2, archivedAt: null, mergedInto: null }],
    links: [{ topicId: 'topic_a', ticketId: 't1', role: 'primary', at: 3 }],
  }))
  writeFileSync(join(dir, 'lessons.json'), JSON.stringify({ schemaVersion: 1, entries: { l1: { id: 'l1', status: 'active', scenario: 's', approach: 'a', pitfall: 'p', createdAt: 4, source: { ticketId: 't1', reportId: 'r1', sessionId: 's1' }, sources: [{ ticketId: 't1' }] } } }))
  { const db = openDatabase(join(dir, 'ria.sqlite'), { create: true }); new SqliteTicketAdapter(db).save(ticket); db.close() }
  const first = migrateDomains({ stateDir: dir })
  assert.equal(first.mode, 'imported')
  assert.deepEqual(first.counts, { topics: 1, links: 1, lessons: 1 })
  assert.ok(existsSync(first.backupDir))
  assert.deepEqual(readdirSync(first.backupDir).sort(), ['lessons.json', 'manifest.json', 'ria.json'])

  const second = migrateDomains({ stateDir: dir })
  assert.equal(second.mode, 'noop')
  assert.deepEqual(second.counts, first.counts)

  const verified = verifySqliteState({ stateDir: dir })
  assert.equal(verified.domains.ok, true)
  assert.deepEqual(verified.domains.counts, { topics: 1, topicLinks: 1, lessons: 1 })

  const db = openDatabase(join(dir, 'ria.sqlite'), { readOnly: true })
  const topicColumns = db.prepare('PRAGMA table_info(topics)').all().map(row => row.name)
  assert.deepEqual(topicColumns, ['id', 'title', 'project_key', 'tags', 'brief', 'archived_at', 'merged_into', 'created_at', 'updated_at'])
  const lessonColumns = db.prepare('PRAGMA table_info(lessons)').all().map(row => row.name)
  assert.deepEqual(lessonColumns, ['id', 'status', 'scenario', 'approach', 'pitfall', 'evidence', 'ticket_id', 'report_id', 'session_id', 'created_at', 'reviewed_at'])
  db.close()

  {
    const write = openDatabase(join(dir, 'ria.sqlite'))
    write.prepare("INSERT INTO topics(id,title,tags,brief,archived_at,merged_into,created_at,updated_at) VALUES('bad','bad','[]','',1,'topic_a',1,1)").run()
    write.prepare("INSERT INTO lessons(id,status,scenario,approach,pitfall,created_at,ticket_id) VALUES('badl','active','s','a','p',1,'missing-ticket')").run()
    write.close()
    const bad = verifySqliteState({ stateDir: dir })
    assert.equal(bad.domains.ok, false)
    assert.ok(bad.domains.issues.includes('topics_archived_and_merged'))
    assert.ok(bad.domains.issues.includes('lessons_orphan_ticket'))
  }

  const failedDir = join(root, 'failed')
  mkdirSync(failedDir, { recursive: true })
  writeFileSync(join(failedDir, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: [ticket], topics: [{ topicId: 'topic_b', title: 'B' }], links: [] }))
  writeFileSync(join(failedDir, 'lessons.json'), JSON.stringify({ entries: {} }))
  { const db = openDatabase(join(failedDir, 'ria.sqlite'), { create: true }); new SqliteTicketAdapter(db).save(ticket); db.close() }
  assert.throws(() => migrateDomains({ stateDir: failedDir, failAfterTopics: true }), /injected failure/)
  const failedDb = openDatabase(join(failedDir, 'ria.sqlite'), { readOnly: true })
  assert.equal(failedDb.prepare('SELECT COUNT(*) n FROM topics').get().n, 0)
  assert.equal(failedDb.prepare("SELECT value FROM schema_meta WHERE key='domain_migration'").get(), undefined)
  failedDb.close()
  assert.ok(readdirSync(failedDir).some(name => name.startsWith('domain-migration-')), 'backup retained on failure')
  console.log('sqlite domain migration ok')
} finally { rmSync(root, { recursive: true, force: true }) }