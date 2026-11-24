import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaStore } from '../lib/index.js'
import { StateWriter } from '../lib/state/writer.mjs'
import { TicketRepository } from '../lib/state/tickets-repository.mjs'
import { openDatabase, transaction } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketRuntime } from '../lib/state/sqlite/runtime.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ria-domain-write-'))
try {
  writeFileSync(join(dir, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: [], topics: [{ topicId: 'legacy_topic', title: 'Legacy', createdAt: 1, updatedAt: 1, tags: [] }], links: [] }))
  writeFileSync(join(dir, 'lessons.json'), JSON.stringify({ schemaVersion: 1, entries: { old: { id: 'old', status: 'active', scenario: 'old', approach: 'a', pitfall: 'p', createdAt: 1 } } }))
  const db = openDatabase(join(dir, 'ria.sqlite'), { create: true })
  const runtime = new SqliteTicketRuntime({ stateDir: dir, dbPath: join(dir, 'ria.sqlite') })
  const store = new RiaStore(dir, { runtime })
  let repository
  const writer = new StateWriter({ transaction: task => repository.transaction(task) })
  repository = new TicketRepository(store, writer, { transaction: task => transaction(runtime.db, task) })
  const ticket = repository.runSync('create', () => store.addTicket({ status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'g', acceptance: 'a' }))
  const topic = store.addTopic({ title: 'SQL Topic', projectKey: 'p', tags: ['t'] })
  assert.equal(runtime.db.prepare('SELECT COUNT(*) n FROM topics').get().n, 1)
  assert.equal(runtime.db.prepare('SELECT COUNT(*) n FROM topic_links').get().n, 0)

  store.linkTicket(topic.topicId, ticket.ticketId, 'primary')
  store.linkTicket(topic.topicId, ticket.ticketId, 'primary')
  assert.equal(runtime.db.prepare('SELECT COUNT(*) n FROM topic_links').get().n, 1, 'linkTopic is idempotent')
  assert.equal(runtime.db.prepare('SELECT role FROM topic_links WHERE topic_id=? AND ticket_id=?').get(topic.topicId, ticket.ticketId).role, 'primary')

  const target = store.addTopic({ title: 'Target' })
  store.linkTicket(target.topicId, ticket.ticketId, 'related')
  store.updateTopic(topic.topicId, { title: 'Renamed', tags: ['a', 'b'] })
  assert.equal(runtime.db.prepare('SELECT title FROM topics WHERE id=?').get(topic.topicId).title, 'Renamed')

  // Inject a target update failure: merge must roll back both link moves and source archive.
  runtime.db.exec("CREATE TRIGGER fail_merge BEFORE UPDATE ON topics WHEN NEW.title='Target' BEGIN SELECT RAISE(ABORT,'merge boom'); END")
  assert.throws(() => store.mergeTopic(topic.topicId, target.topicId), /merge boom/)
  runtime.db.exec('DROP TRIGGER fail_merge')
  assert.equal(runtime.db.prepare('SELECT COUNT(*) n FROM topic_links WHERE topic_id=?').get(topic.topicId).n, 1)
  assert.equal(runtime.db.prepare('SELECT archived_at FROM topics WHERE id=?').get(topic.topicId).archived_at, null)

  const merged = store.mergeTopic(topic.topicId, target.topicId)
  assert.equal(merged.moved, 1)
  assert.equal(runtime.db.prepare('SELECT COUNT(*) n FROM topic_links WHERE topic_id=?').get(topic.topicId).n, 0)
  const source = runtime.db.prepare('SELECT archived_at,merged_into FROM topics WHERE id=?').get(topic.topicId)
  assert.ok(source.archived_at)
  assert.equal(source.merged_into, target.topicId)

  const openTopic = store.addTopic({ title: 'Open' })
  store.linkTicket(openTopic.topicId, ticket.ticketId, 'related')
  assert.throws(() => store.archiveTopic(openTopic.topicId), { code: 'topic_unfinished' })
  // Reopen fresh runtime + store (simulating restart where store.data.links is empty) and verify archiveTopicSql still sees SQLite links.
  await runtime.close()
  const runtimeReopen = new SqliteTicketRuntime({ stateDir: dir, dbPath: join(dir, 'ria.sqlite') })
  const storeReopen = new RiaStore(dir, { runtime: runtimeReopen })
  assert.throws(() => storeReopen.archiveTopic(openTopic.topicId), { code: 'topic_unfinished' }, 'archiveTopicSql must query SQLite links after restart')
  storeReopen.unlinkTicket(target.topicId, ticket.ticketId)
  storeReopen.unlinkTicket(openTopic.topicId, ticket.ticketId)
  assert.equal(storeReopen.archiveTopic(openTopic.topicId).archivedAt > 0, true)

  // Verify RiaStore.addFeedback persists into SQLite ticket_feedback and survives restart.
  storeReopen.addFeedback({ ticketId: ticket.ticketId, kind: 'note', code: 'check', body: 'persisted feedback', at: 12345 })
  assert.equal(runtimeReopen.db.prepare('SELECT COUNT(*) n FROM ticket_feedback').get().n, 1)
  await runtimeReopen.close()
  const runtimeReload = new SqliteTicketRuntime({ stateDir: dir, dbPath: join(dir, 'ria.sqlite') })
  const storeReload = new RiaStore(dir, { runtime: runtimeReload })
  assert.equal(storeReload.data.ticketFeedback.length, 1)
  assert.equal(storeReload.data.ticketFeedback[0].body, 'persisted feedback')

  const legacy = JSON.parse(readFileSync(join(dir, 'ria.json'), 'utf8'))
  assert.deepEqual(legacy.topics.map(item => item.topicId), ['legacy_topic'], 'ria.json topics stay legacy')
  assert.deepEqual(legacy.links, [], 'ria.json links stay legacy')
  await runtimeReload.close()
  db.close()
  console.log('sqlite domain write ok')
} finally { rmSync(dir, { recursive: true, force: true }) }