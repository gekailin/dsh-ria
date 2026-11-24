import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaStore } from '../lib/index.js'
import { openDatabase } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../lib/state/sqlite/adapter.mjs'
import { SqliteTicketRuntime } from '../lib/state/sqlite/runtime.mjs'
import { topicSuggestions } from '../lib/topics.mjs'

const ticket = { ticketId: 't1', status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'topic read', acceptance: 'a', revision: 1, createdAt: 100, updatedAt: 100, attempt: { legacy: true }, failure: null, resolution: null, history: [] }
const legacyTopics = [{ topicId: 'topic_a', title: 'Alpha', projectKey: 'p', tags: ['t'], brief: 'b', createdAt: 1, updatedAt: 2, archivedAt: null, mergedInto: null }]
const legacyLinks = [{ topicId: 'topic_a', ticketId: 't1', role: 'primary', at: 3 }]
const dir = mkdtempSync(join(tmpdir(), 'ria-domain-read-'))
try {
  writeFileSync(join(dir, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: [ticket], topics: legacyTopics, links: legacyLinks }))
  writeFileSync(join(dir, 'lessons.json'), JSON.stringify({ entries: { l1: { id: 'l1', status: 'active', scenario: 's', approach: 'a', pitfall: 'p', createdAt: 4 } } }))
  {
    const db = openDatabase(join(dir, 'ria.sqlite'), { create: true })
    new SqliteTicketAdapter(db).save(ticket)
    db.prepare('INSERT INTO topics(id,title,project_key,tags,brief,archived_at,merged_into,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('topic_a', 'Alpha', 'p', '["t"]', 'b', null, null, 1, 2)
    db.prepare('INSERT INTO topic_links(topic_id,ticket_id,role,created_at) VALUES(?,?,?,?)').run('topic_a', 't1', 'primary', 3)
    db.close()
  }
  const runtime = new SqliteTicketRuntime({ stateDir: dir })
  const store = new RiaStore(dir, { runtime })
  assert.deepEqual(store.topics().map(topic => topic.topicId), ['topic_a'])
  assert.deepEqual(store.links(), legacyLinks)
  assert.deepEqual(store.topicLinks('topic_a'), legacyLinks)
  assert.deepEqual(store.ticketLinks('t1'), legacyLinks)
  assert.equal(store.primaryTopicFor('t1'), 'topic_a')
  assert.deepEqual(topicSuggestions({ goal: 'topic read', topics: store.topics(), links: store.links(), tickets: store.tickets() }).topics.map(item => item.topicId), ['topic_a'])

  runtime.db.prepare("UPDATE topics SET title='External' WHERE id='topic_a'").run()
  assert.equal(store.topics()[0].title, 'External', 'SQL is authoritative over the old cache')

  await runtime.close()
  const emptyDir = mkdtempSync(join(tmpdir(), 'ria-domain-empty-'))
  try {
    writeFileSync(join(emptyDir, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: [] }))
    { const db = openDatabase(join(emptyDir, 'ria.sqlite'), { create: true }); db.close() }
    const emptyRuntime = new SqliteTicketRuntime({ stateDir: emptyDir })
    const emptyStore = new RiaStore(emptyDir, { runtime: emptyRuntime })
    assert.deepEqual(emptyStore.topics(), [])
    assert.deepEqual(emptyStore.links(), [])
    assert.equal(emptyStore.primaryTopicFor('none'), null)
    await emptyRuntime.close()
  } finally { rmSync(emptyDir, { recursive: true, force: true }) }
  console.log('sqlite domain read ok')
} finally { rmSync(dir, { recursive: true, force: true }) }