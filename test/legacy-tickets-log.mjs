import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveLegacyTicketsLog } from '../lib/state/legacy-tickets-log.mjs'
import { writeMirrorSnapshot } from '../lib/state/sqlite/mirror.mjs'
import { readStateSource } from '../lib/state/sqlite/source.mjs'
import { seedSqliteFromState } from './support/sqlite-seed.mjs'
import { RiaStore } from '../lib/index.js'
import { SqliteTicketRuntime } from '../lib/state/sqlite/runtime.mjs'

const dirs = []
const make = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ria-legacy-tickets-log-'))
  dirs.push(dir)
  return dir
}
const events = dir => {
  const file = join(dir, 'router-events.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

try {
  // 1. The SQLite mirror no longer publishes the retired ticket log.
  {
    const dir = make()
    writeMirrorSnapshot({
      stateDir: dir,
      snapshot: {
        generation: 1,
        state: { chatSessionId: 'session-chat' },
        ria: { tickets: [] },
        archives: [{ ticket: { ticketId: 'archived' }, closedAt: 1 }],
        counts: { tickets: 1 },
      },
    })
    assert.equal(existsSync(join(dir, 'state.json')), true, 'state mirror still writes')
    assert.equal(existsSync(join(dir, 'tickets.log.jsonl')), false, 'retired ticket log is never published')
  }

  // 2. Legacy file is archived once, with one event; a second call is a no-op.
  {
    const dir = make()
    const legacy = join(dir, 'tickets.log.jsonl')
    writeFileSync(legacy, '{"ticket":{"ticketId":"legacy"}}\n')
    const first = archiveLegacyTicketsLog(dir, { now: () => Date.parse('2026-11-24T10:15:00Z') })
    assert.equal(first.archived, true, JSON.stringify(first))
    assert.equal(existsSync(legacy), false)
    assert.equal(existsSync(first.to), true)
    assert.match(first.to, /tickets\.log\.jsonl\.bak-20261124T101500Z$/)
    const afterFirst = events(dir).filter(event => event.event === 'legacy.tickets_log.archived')
    assert.equal(afterFirst.length, 1)
    assert.equal(afterFirst[0].payload.from, legacy)
    assert.equal(afterFirst[0].payload.to, first.to)
    assert.equal(afterFirst[0].payload.bytes, readFileSync(first.to).length)
    const second = archiveLegacyTicketsLog(dir, { now: () => Date.parse('2026-11-24T10:15:01Z') })
    assert.equal(second.archived, false)
    assert.equal(events(dir).filter(event => event.event === 'legacy.tickets_log.archived').length, 1)
    const files = readdirSync(dir).filter(name => name.startsWith('tickets.log.jsonl.bak-'))
    assert.equal(files.length, 1, 'second call creates no second backup')
  }

  // 3. Offline source reads the authoritative SQLite DB, not tickets.log.
  {
    const dir = make()
    const hot = { ticketId: 'hot', status: 'open', waitingOn: 'ria', executor: 'advisor', goal: 'hot', acceptance: '', revision: 1, createdAt: 1, updatedAt: 1, closedAt: null }
    const archived = { ticketId: 'archived', status: 'done', waitingOn: 'none', executor: 'advisor', goal: 'done', acceptance: '', revision: 1, createdAt: 1, updatedAt: 1, closedAt: 2, resolution: { summary: 'done' } }
    writeFileSync(join(dir, 'ria.json'), JSON.stringify({ schemaVersion: 5, tickets: [hot] }))
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ reports: [] }))
    seedSqliteFromState({ stateDir: dir, extraRecords: [{ ticket: archived, archivedAt: 2 }] })
    assert.equal(existsSync(join(dir, 'tickets.log.jsonl')), false)
    const source = readStateSource(dir)
    assert.deepEqual(source.records.map(record => record.ticket.ticketId).sort(), ['archived', 'hot'])
    assert.deepEqual(source.counts, { tickets: 2, history: 0, hot: 1, archived: 1, meta: 0 })
    assert.equal(source.files.some(file => file.name === 'ria.sqlite'), true)

    // A real store write + mirror flush after ticket creation still does not
    // recreate the retired file.
    const runtime = new SqliteTicketRuntime({ stateDir: dir, debounceMs: 0,
      exportMirror: (snapshot, guard) => writeMirrorSnapshot({ stateDir: dir, snapshot, ...guard }) })
    try {
      const store = new RiaStore(dir, { runtime })
      const created = store.addTicket({ goal: 'new ticket after retirement', status: 'open', executor: 'advisor' })
      assert.ok(created.ticketId)
      runtime.flush()
      assert.equal(existsSync(join(dir, 'tickets.log.jsonl')), false, 'ticket creation does not recreate the log')
    } finally { runtime.close() }
  }

  console.log('legacy tickets log removal ok')
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}
