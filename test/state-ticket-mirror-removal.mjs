import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ria-state-meta-removal-'))
try {
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    tickets: { legacy: { ticketId: 'legacy', projectCwd: '/legacy' } },
    ticketMirror: { generation: 7 },
    workers: {},
    meta: { workerSeq: 0, reflectionSeq: 0 },
  }))
  const store = new StateStore(dir, { metaAuthority: 'sqlite' })
  assert.equal(store.data.tickets, undefined, 'legacy ticket mirror removed on load')
  assert.equal(store.data.ticketMirror, undefined, 'legacy mirror generation removed on load')
  store.save()
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.tickets, undefined, 'save never writes ticket meta')
  assert.equal(saved.ticketMirror, undefined, 'save never writes mirror generation')

  // Metadata reads must use the DB adapter, not the JSON mirror.
  store.sqliteRuntime = {
    adapter: {
      record: id => ({ meta: { ticketId: id, scope: 'global', source: 'db' } }),
      records: () => [{ meta: { ticketId: 'db-ticket', source: 'db' } }],
    },
  }
  Object.defineProperty(store.data, 'tickets', {
    configurable: true,
    get() { throw new Error('state.tickets must not be read when SQLite owns meta') },
  })
  assert.deepEqual(store.ticketMeta('db-ticket'), { ticketId: 'db-ticket', scope: 'global', source: 'db' })
  assert.deepEqual(store.ticketMetas(), [{ ticketId: 'db-ticket', source: 'db' }])
  console.log('state ticket mirror removal ok')
} finally { rmSync(dir, { recursive: true, force: true }) }