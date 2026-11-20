import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { RiaStore } from '../lib/index.js'
import { V2Store } from '../lib/store/store.mjs'
import { StateWriter } from '../lib/state/writer.mjs'
import { TicketRepository } from '../lib/state/tickets-repository.mjs'
import { openDatabase, transaction } from '../lib/state/sqlite/db.mjs'
import { SqliteTicketAdapter } from '../lib/state/sqlite/adapter.mjs'
import { SqliteTicketRuntime } from '../lib/state/sqlite/runtime.mjs'
import { writeMirrorSnapshot } from '../lib/state/sqlite/mirror.mjs'
import { writeAtomic } from '../lib/state/atomic-file.mjs'
import { normalizeTicket } from '../lib/tickets.mjs'
import { exportTickets } from '../scripts/sqlite-export.mjs'

class Clock {
  tasks = new Map()
  next = 1
  time = 1000
  setTimeout = (callback, delay) => {
    const id = this.next++
    this.tasks.set(id, { callback, delay })
    return id
  }
  clearTimeout = id => this.tasks.delete(id)
  now = () => this.time
  tick() {
    const entry = this.tasks.entries().next().value
    assert.ok(entry, 'a subsequent export is scheduled')
    this.tasks.delete(entry[0])
    this.time += entry[1].delay
    entry[1].callback()
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ria-sqlite-mirror-'))
  const dbPath = join(dir, 'ria.sqlite')
  const db = openDatabase(dbPath, { create: true })
  const adapter = new SqliteTicketAdapter(db)
  const old = Date.now() - 3 * 24 * 60 * 60 * 1000
  transaction(db, () => {
    for (const id of ['first', 'second']) adapter.save(normalizeTicket({
      ticketId: id, status: 'open', executor: 'advisor', waitingOn: 'ria', goal: id,
      createdAt: old, updatedAt: old,
    }), { meta: { ticketId: id, scope: 'global', projectId: null, attachments: ['db'],
      metaRevision: 3, updatedAt: 123 } })
    for (let i = 0; i < 53; i++) adapter.save(normalizeTicket({
      ticketId: 'terminal' + i, status: 'done', executor: 'advisor', waitingOn: 'none', goal: 'done',
      closedAt: old - i, createdAt: old - i, updatedAt: old - i,
    }), { meta: { ticketId: 'terminal' + i, scope: 'global' } })
  })
  db.close()
  writeFileSync(join(dir, 'ria.json'), JSON.stringify({ schemaVersion: 5, version: 5,
    tickets: [{ ticketId: 'json-only', status: 'open', goal: 'stale' }], settings: { blockDirectUserMessages: true } }))
  writeFileSync(join(dir, 'v2.json'), JSON.stringify({ tickets: {
    first: { scope: 'stale-json', attachments: ['stale'], metaRevision: 99999, updatedAt: 9999999999999 },
    absent: { scope: 'must-not-import' },
  }, reports: [], workers: {} }))
  const clock = new Clock()
  const logs = []
  const runtime = new SqliteTicketRuntime({ stateDir: dir, clock, debounceMs: 25, retryMs: 100,
    log: (level, message) => logs.push({ level, message }) })
  const store = new RiaStore(dir, { runtime })
  let repository
  const writer = new StateWriter({ transaction: task => repository.transaction(task) })
  repository = new TicketRepository(store, writer, { transaction: task => transaction(runtime.db, task) })
  const v2 = new V2Store(dir)
  repository.attachV2(v2)
  runtime.exportMirror = (snapshot, guard) => writeMirrorSnapshot({ stateDir: dir, snapshot, ...guard })
  runtime.scheduleMirror()
  const reader = openDatabase(dbPath, { readOnly: true })
  const external = new SqliteTicketAdapter(reader)
  const read = name => JSON.parse(readFileSync(join(dir, name), 'utf8'))
  const dbState = () => JSON.parse(external.getSchemaMeta('ticket_mirror'))
  const cleanup = async () => {
    await runtime.close()
    reader.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, runtime, store, v2, repository, clock, logs, external, reader, read, dbState, cleanup }
}

// DB ticket meta replaces stale JSON even when its timestamp/version looks newer.
// Failed SQL commits never publish dirty drafts or touch retained live references.
{
  const f = setup()
  try {
    const { runtime, store, v2, repository, external } = f
    assert.equal(v2.ticketMeta('first').scope, 'global')
    assert.deepEqual(v2.ticketMeta('first').attachments, ['db'])
    assert.equal(v2.data.tickets.absent, undefined)
    assert.equal(store.ticket('json-only'), undefined)
    const liveMeta = v2.ticketMeta('first')
    const liveAttachments = liveMeta.attachments
    const live = v2.data
    const before = structuredClone(live)
    const beforeTickets = structuredClone(store.data)
    const beforeMirror = f.dbState()
    const beforeSignatures = [...runtime.metaPersisted]
    const save = runtime.adapter.save.bind(runtime.adapter)
    runtime.adapter.save = () => {
      assert.deepEqual(live, before)
      assert.deepEqual(store.runtime.storeSlot.data, beforeTickets)
      throw new Error('meta SQL failed')
    }
    assert.throws(() => v2.setTicketMeta('first', { scope: 'never-publish', attachments: ['dirty'] }), /meta SQL failed/)
    runtime.adapter.save = save
    assert.strictEqual(v2.ticketMeta('first'), liveMeta)
    assert.strictEqual(liveMeta.attachments, liveAttachments)
    assert.deepEqual(v2.data, before)
    assert.deepEqual(external.record('first').meta, liveMeta)
    assert.deepEqual(f.dbState(), beforeMirror)
    assert.deepEqual([...runtime.metaPersisted], beforeSignatures)

    await assert.rejects(repository.run('compound-meta-rollback', () => {
      store.noteTicket('first', { reason: 'rollback all domains' })
      v2.setTicketMeta('first', { projectId: 'not-committed' })
      v2.addReport({ reportId: 'report-dirty', ticketId: 'first', summary: 'must roll back' })
      v2.addWorker('worker-dirty')
      throw new Error('compound aborted')
    }), /compound aborted/)
    assert.deepEqual(store.data, beforeTickets)
    assert.deepEqual(v2.data, before)
    assert.deepEqual(f.dbState(), beforeMirror)

    const next = v2.setTicketMeta('first', { scope: 'project', projectId: 'new', attachments: ['new'] }, { expectedRevision: 3 })
    assert.strictEqual(next, liveMeta)
    assert.strictEqual(next.attachments, liveAttachments)
    assert.equal(next.metaRevision, 4)
    assert.ok(next.updatedAt > 123)
    assert.deepEqual(external.record('first').meta, next)
    const committed = structuredClone(v2.data)
    assert.throws(() => v2.setTicketMeta('first', { scope: 'stale-request' }, { expectedRevision: 3 }), { code: 'stale_revision' })
    assert.deepEqual(v2.data, committed)

    repository.runSync('draft-meta', () => { v2.ticketMeta('first').projectId = 'latest draft' })
    assert.equal(v2.ticketMeta('first').metaRevision, 5)
    assert.equal(external.record('first').meta.projectId, 'latest draft')
    repository.runSync('new-ticket-and-meta', () => {
      const ticket = store.addTicket({ goal: 'new ticket' })
      v2.setTicketMeta(ticket.ticketId, { scope: 'project', attachments: ['same-commit'] })
    })
    assert.ok(external.records().some(record => record.meta?.attachments?.includes('same-commit')))

    assert.equal(runtime.flush(), true)
    assert.deepEqual(f.read('v2.json').tickets.first, external.record('first').meta)
    assert.deepEqual(f.read('ria.json').tickets, runtime.hotTickets())
    assert.equal(runtime.dirty, false)
    assert.equal(f.dbState().dirty, false)
  } finally { await f.cleanup() }
}

// Export failure leaves durable dirty+latest non-ticket payload. A later timer
// retries without a new ticket write and logs the first failure.
{
  const f = setup()
  try {
    const { runtime, clock, v2, store } = f
    store.setSettings({ blockDirectUserMessages: false })
    v2.addReport({ reportId: 'report-new', ticketId: 'first', summary: 'keep non-ticket fields' })
    v2.setTicketMeta('first', { attachments: ['latest'] })
    const previous = readFileSync(join(f.dir, 'v2.json'), 'utf8')
    let calls = 0
    runtime.exportMirror = (snapshot, guard) => {
      if (++calls === 1) throw new Error('export once failed')
      return writeMirrorSnapshot({ stateDir: f.dir, snapshot, ...guard })
    }
    assert.doesNotThrow(() => clock.tick())
    assert.equal(runtime.dirty, true)
    assert.equal(f.dbState().dirty, true)
    assert.match(runtime.stats().lastError.message, /export once failed/)
    assert.equal(runtime.stats().failures, 1)
    assert.ok(f.logs.some(item => item.level === 'warn' && item.message.includes('remains dirty')))
    assert.equal(readFileSync(join(f.dir, 'v2.json'), 'utf8'), previous)
    assert.equal(f.dbState().pendingV2.reports.at(-1).reportId, 'report-new')
    assert.equal(f.dbState().pendingRia.settings.blockDirectUserMessages, false)
    clock.tick()
    assert.equal(calls, 2)
    assert.equal(runtime.dirty, false)
    assert.equal(f.dbState().exportedGeneration, runtime.generation)
    assert.equal(runtime.stats().lastError, null)
    assert.deepEqual(f.read('v2.json').tickets.first.attachments, ['latest'])
    assert.equal(f.read('v2.json').reports.at(-1).reportId, 'report-new')
    assert.equal(f.read('ria.json').settings.blockDirectUserMessages, false)
  } finally { await f.cleanup() }
}

// Publication fences reject an old in-flight export, including a new write
// between writing/fsyncing a temp file and rename. New metadata cannot be lost.
{
  const f = setup()
  try {
    const { runtime, v2, store } = f
    runtime.flush()
    const before = readFileSync(join(f.dir, 'v2.json'), 'utf8')
    v2.setTicketMeta('first', { attachments: ['old-inflight'] })
    let changed = false
    runtime.exportMirror = (snapshot, guard) => writeMirrorSnapshot({ stateDir: f.dir, snapshot, ...guard,
      write(file, text, options) {
        writeAtomic(file, text, { ...options, beforeRename() {
          if (!changed) {
            changed = true
            v2.setTicketMeta('first', { attachments: ['newer-write'] })
            v2.addReport({ reportId: 'during-export', ticketId: 'first', summary: 'new report' })
            store.noteTicket('first', { reason: 'during-export' })
          }
          options.beforeRename()
        } })
      },
    })
    assert.throws(() => runtime.flush(), { code: 'mirror_superseded' })
    assert.equal(readFileSync(join(f.dir, 'v2.json'), 'utf8'), before)
    assert.equal(runtime.dirty, true)
    assert.equal(readdirSync(f.dir).some(name => name.endsWith('.tmp')), false)
    runtime.exportMirror = (snapshot, guard) => writeMirrorSnapshot({ stateDir: f.dir, snapshot, ...guard })
    assert.equal(runtime.flush(), true)
    assert.deepEqual(f.read('v2.json').tickets.first, f.external.record('first').meta)
    assert.deepEqual(f.read('v2.json').tickets.first.attachments, ['newer-write'])
    assert.equal(f.read('v2.json').reports.at(-1).reportId, 'during-export')
    assert.deepEqual(f.read('ria.json').tickets, runtime.hotTickets())
  } finally { await f.cleanup() }
}

// Async exporters are single-flight. Concurrent writes invalidate old snapshots,
// and rejection drains the same in-flight promise before the next retry.
{
  const f = setup()
  try {
    let release
    f.runtime.exportMirror = (snapshot, guard) => new Promise((resolve, reject) => {
      release = () => {
        try { resolve(writeMirrorSnapshot({ stateDir: f.dir, snapshot, ...guard })) }
        catch (cause) { reject(cause) }
      }
    })
    const pending = f.runtime.flush()
    assert.strictEqual(f.runtime.flush(), pending)
    f.v2.setTicketMeta('second', { projectId: 'concurrent' })
    release()
    await assert.rejects(pending, { code: 'mirror_superseded' })
    assert.equal(f.runtime.dirty, true)
    assert.equal(f.runtime.inFlight, null)
    assert.equal(f.runtime.flushing, false)
    f.runtime.exportMirror = (snapshot, guard) => writeMirrorSnapshot({ stateDir: f.dir, snapshot, ...guard })
    assert.equal(f.runtime.flush(), true)
    assert.equal(f.read('v2.json').tickets.second.projectId, 'concurrent')
  } finally { await f.cleanup() }
}


// Newly archived ticket snapshots, including their newest DB meta, survive
// partial mirror failure and are present in both online and offline exports.
{
  const f = setup()
  try {
    const { runtime, store, v2 } = f
    const archived = store.archiveClosedTickets()
    assert.ok(archived.archived > 0)
    const record = f.external.records().find(item => item.archivedAt !== null)
    assert.ok(record.archiveRecords.length)
    v2.setTicketMeta(record.ticket.ticketId, { projectId: 'archived-meta', attachments: ['archived-new'] })
    let failed = false
    runtime.exportMirror = (snapshot, guard) => writeMirrorSnapshot({ stateDir: f.dir, snapshot, ...guard,
      write(file, text, options) {
        if (!failed && basename(file) === 'ria.json') { failed = true; throw new Error('last file failed') }
        writeAtomic(file, text, options)
      },
    })
    assert.throws(() => runtime.flush(), /last file failed/)
    assert.equal(runtime.dirty, true)
    const offline = exportTickets({ stateDir: f.dir })
    assert.ok(offline.archives.some(item => item.ticket.ticketId === record.ticket.ticketId))
    assert.equal(offline.v2.tickets[record.ticket.ticketId].projectId, 'archived-meta')
    runtime.exportMirror = (snapshot, guard) => writeMirrorSnapshot({ stateDir: f.dir, snapshot, ...guard })
    assert.equal(runtime.flush(), true)
    const archiveLines = readFileSync(join(f.dir, 'tickets.log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(archiveLines.some(item => item.ticket.ticketId === record.ticket.ticketId))
    assert.deepEqual(f.read('v2.json').tickets[record.ticket.ticketId], f.external.record(record.ticket.ticketId).meta)
    assert.equal(f.read('ria.json').ticketMirror.generation, f.read('v2.json').ticketMirror.generation)
  } finally { await f.cleanup() }
}

// Durable dirty state survives a process crash: a new runtime restores the
// latest non-ticket recovery payload and retries the full mirror publication.
{
  const f = setup()
  let runtime2
  try {
    const { runtime, store, v2 } = f
    runtime.exportMirror = () => { throw new Error('crash before export') }
    store.setSettings({ blockDirectUserMessages: false })
    v2.addReport({ reportId: 'report-reopen', ticketId: 'first', summary: 'reopen payload' })
    v2.setTicketMeta('first', { attachments: ['pending-reopen'] })
    assert.throws(() => runtime.flush(), /crash before export/)
    await runtime.close()

    const clock2 = new Clock()
    runtime2 = new SqliteTicketRuntime({ stateDir: f.dir, clock: clock2, debounceMs: 10, retryMs: 20 })
    const store2 = new RiaStore(f.dir, { runtime: runtime2 })
    let repository2
    const writer2 = new StateWriter({ transaction: task => repository2.transaction(task) })
    repository2 = new TicketRepository(store2, writer2, { transaction: task => transaction(runtime2.db, task) })
    const v2b = new V2Store(f.dir)
    repository2.attachV2(v2b)
    assert.equal(runtime2.dirty, true)
    assert.equal(runtime2.stats().exportedGeneration < runtime2.generation, true)
    assert.equal(store2.data.settings.blockDirectUserMessages, false)
    assert.equal(v2b.data.reports.at(-1).reportId, 'report-reopen')
    assert.equal(v2b.ticketMeta('first').attachments[0], 'pending-reopen')
    runtime2.exportMirror = (snapshot, guard) => writeMirrorSnapshot({ stateDir: f.dir, snapshot, ...guard })
    assert.equal(runtime2.flush(), true)
    assert.equal(runtime2.dirty, false)
    assert.equal(f.read('v2.json').reports.at(-1).reportId, 'report-reopen')
    assert.equal(f.read('ria.json').settings.blockDirectUserMessages, false)
    assert.deepEqual(f.read('v2.json').tickets.first, f.external.record('first').meta)
  } finally {
    if (runtime2) await runtime2.close()
    f.reader.close()
    rmSync(f.dir, { recursive: true, force: true })
  }
}

// An async timer export failure is recorded and automatically retried; the
// rejected in-flight promise is drained and never becomes unhandled.
{
  const f = setup()
  try {
    const { runtime, clock, v2 } = f
    runtime.flush()
    let calls = 0
    runtime.exportMirror = async (snapshot, guard) => {
      calls += 1
      if (calls === 1) throw new Error('async rejected')
      return writeMirrorSnapshot({ stateDir: f.dir, snapshot, ...guard })
    }
    v2.setTicketMeta('first', { attachments: ['async-retry'] })
    clock.tick()
    const inflight = runtime.inFlight
    assert.ok(inflight)
    await assert.rejects(inflight, /async rejected/)
    assert.equal(runtime.dirty, true)
    assert.match(runtime.stats().lastError.message, /async rejected/)
    clock.tick()
    if (runtime.inFlight) await runtime.inFlight
    assert.equal(calls, 2)
    assert.equal(runtime.dirty, false)
    assert.deepEqual(f.read('v2.json').tickets.first.attachments, ['async-retry'])
  } finally { await f.cleanup() }
}

// Deleting a meta entry in the private draft nulls the DB meta namespace; a
// stale JSON value can never resurrect it on the next export.
{
  const f = setup()
  try {
    const { runtime, repository, v2 } = f
    runtime.flush()
    repository.runSync('delete-meta', () => { delete v2.data.tickets.second })
    assert.equal(f.external.record('second').meta, null)
    assert.equal(runtime.flush(), true)
    assert.equal(f.read('v2.json').tickets.second, undefined)
    assert.equal(f.read('ria.json').tickets.find(item => item.ticketId === 'second').ticketId, 'second')
  } finally { await f.cleanup() }
}

// New tickets get DB-owned meta in the same transaction as the ticket row.
{
  const f = setup()
  try {
    let id
    assert.throws(() => f.repository.runSync('create-rollback', () => {
      const created = f.store.addTicket({ status: 'intake', waitingOn: 'ria', executor: null, goal: 'rollback' })
      id = created.ticketId
      f.v2.setTicketMeta(id, { scope: 'global', workerId: 'w1', projectCwd: '/x' })
      throw new Error('force rollback')
    }), /force rollback/)
    assert.equal(f.external.record(id), undefined, 'ticket and meta roll back together')

    const created = f.repository.runSync('create-with-meta', () => {
      const ticket = f.store.addTicket({ status: 'intake', waitingOn: 'ria', executor: null, goal: 'with meta' })
      f.v2.setTicketMeta(ticket.ticketId, { scope: 'global', workerId: 'w2', projectCwd: '/repo' })
      return ticket
    })
    const record = f.external.record(created.ticketId)
    assert.ok(record.meta, 'DB meta is written with the new ticket')
    assert.equal(record.meta.scope, 'global')
    assert.equal(record.meta.workerId, 'w2')
    assert.equal(record.meta.projectCwd, '/repo')
    assert.equal(record.meta.ticketId, created.ticketId)
  } finally { await f.cleanup() }
}

console.log('sqlite DB metadata authority and durable mirror retry ok')
