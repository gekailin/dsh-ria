import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaStore } from '../lib/index.js'
import { SqliteTicketRuntime } from '../lib/state/sqlite/runtime.mjs'
import { publishState } from '../lib/state/snapshot.mjs'
import { seedSqliteFromState } from './support/sqlite-seed.mjs'

const ticket = id => ({
  ticketId: id, status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'goal ' + id,
  acceptance: 'x', revision: 1, createdAt: 1, updatedAt: 1, closedAt: null,
  attempt: { legacy: true }, failure: null, resolution: null,
  progress: { lastPhase: '', lastEventAt: 0 },
  history: [{ at: 1, actor: 'router', from: 'intake', to: 'open', reason: 'route' }],
})
const ids = ['ticket_a', 'ticket_b', 'ticket_c']
const makeState = () => ({ schemaVersion: 5, version: 5, tickets: ids.map(ticket), settings: { progressCards: false }, storage: 'json' })

// publishState must keep every link of one topic; bare topicId identity collapsed
// them onto one old link object.
{
  const target = { links: [{ topicId: 'topic_t', ticketId: 'ticket_a', role: 'primary', at: 1 }] }
  const source = { links: ids.map(id => ({ topicId: 'topic_t', ticketId: id, role: 'primary', at: 2 })) }
  publishState(target, source)
  assert.deepEqual(target.links.map(link => link.ticketId), ids)
}

const root = mkdtempSync(join(tmpdir(), 'ria-snapshot-links-'))
try {
  // JSON mode
  const jsonDir = join(root, 'json')
  writeFileSync(join(jsonDir + '.tmp'), '')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(jsonDir, { recursive: true })
  writeFileSync(join(jsonDir, 'ria.json'), JSON.stringify(makeState(), null, 2) + '\n')
  const jsonStore = new RiaStore(jsonDir)
  const jsonTopic = jsonStore.addTopic({ title: 'JSON topic' })
  for (const id of ids) jsonStore.linkTicket(jsonTopic.topicId, id, 'primary')
  jsonStore.linkTicket(jsonTopic.topicId, ids[0], 'primary')
  const jsonLinks = jsonStore.links().filter(link => link.topicId === jsonTopic.topicId)
  assert.equal(jsonLinks.length, 3)
  assert.deepEqual(jsonLinks.map(link => link.ticketId).sort(), ids.slice().sort())
  assert.equal(jsonLinks.filter(link => link.ticketId === ids[0]).length, 1)

  // SQLite mode: the same write path must publish all N links back to the store.
  const sqliteDir = join(root, 'sqlite')
  mkdirSync(sqliteDir, { recursive: true })
  writeFileSync(join(sqliteDir, 'ria.json'), JSON.stringify(makeState(), null, 2) + '\n')
  seedSqliteFromState({ stateDir: sqliteDir })
  const runtime = new SqliteTicketRuntime({ stateDir: sqliteDir })
  const sqliteStore = new RiaStore(sqliteDir, { runtime })
  const sqliteTopic = runtime.writeStore(() => sqliteStore.addTopic({ title: 'SQLite topic' }))
  runtime.writeStore(() => {
    for (const id of ids) sqliteStore.linkTicket(sqliteTopic.topicId, id, 'primary')
    sqliteStore.linkTicket(sqliteTopic.topicId, ids[0], 'primary')
  })
  const sqliteLinks = sqliteStore.links().filter(link => link.topicId === sqliteTopic.topicId)
  assert.equal(sqliteLinks.length, 3)
  assert.deepEqual(sqliteLinks.map(link => link.ticketId).sort(), ids.slice().sort())
  assert.equal(sqliteLinks.filter(link => link.ticketId === ids[0]).length, 1)
  runtime.close()
  console.log('snapshot link identity ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
