import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../lib/store/store.mjs'
import { SqliteTicketRuntime } from '../lib/state/sqlite/runtime.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-control-sync-'))
try {
  const dir = join(root, 'state')
  const db = openDatabase(join(dir, 'ria.sqlite'), { create: true })
  db.prepare('INSERT INTO schema_meta(key,value,updated_at) VALUES(?,?,?)').run('ticket_mirror', JSON.stringify({ stale: true }), 1)
  db.close()
  const ria = join(dir, 'ria.json')
  writeFileSync(ria, '{"legacy":true}\n')
  const beforeRia = readFileSync(ria, 'utf8')
  const state = new StateStore(dir, { sqlite: true, eventLog: false })
  const runtime = new SqliteTicketRuntime({ stateDir: dir })
  runtime.attachState(state)
  assert.equal(runtime.db.prepare("SELECT COUNT(*) n FROM schema_meta WHERE key='ticket_mirror'").get().n, 0)

  state.setChat('session-chat')
  let saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.chatSessionId, 'session-chat', 'chatSessionId is on disk before setChat returns')

  state.setSage('session-sage')
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).sageSessionId, 'session-sage')

  state.addExecutor('session-exec', { kind: 'managed', status: 'idle', scope: 'global' })
  saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.executors['session-exec'].sessionId, 'session-exec')

  state.data.settings = { progressCards: true, blockDirectUserMessages: false }
  state.data.coManagement = [{ sessionId: 'session-cm', title: 'CM', cwd: '/tmp/cm', status: 'active', allowDispatch: true }]
  state.data.grants = [{ grantId: 'grant-1', sessionId: 'session-exec', kind: 'debug' }]
  state.save()
  saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.settings.progressCards, true)
  assert.equal(saved.settings.blockDirectUserMessages, false)
  assert.equal(saved.coManagement[0].sessionId, 'session-cm')
  assert.equal(saved.grants[0].grantId, 'grant-1')
  assert.equal(readFileSync(ria, 'utf8'), beforeRia, 'control write never touches ria.json')

  const reloaded = new StateStore(dir, { sqlite: true, eventLog: false })
  assert.equal(reloaded.chatSessionId, 'session-chat')
  assert.equal(reloaded.sageSessionId, 'session-sage')
  assert.equal(reloaded.executor('session-exec').sessionId, 'session-exec')
  assert.equal(reloaded.data.coManagement[0].sessionId, 'session-cm')
  assert.equal(reloaded.data.grants[0].grantId, 'grant-1')

  // syncRiaControl copies all RiaStore-owned control keys (not only settings/grants).
  state.syncRiaControl({
    settings: () => ({ progressCards: false }),
    grants: () => [{ grantId: 'g2' }],
    recentExecutors: () => ({ 'session-exec': { lastUsedAt: 12345, lastTicketId: 't1' } }),
    riaPreset: 'standard',
    lastHumanMessageAt: 99999,
    data: { createdAt: 11111 },
  })
  state.save()
  const syncedDisk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.deepEqual(syncedDisk.recentExecutors, { 'session-exec': { lastUsedAt: 12345, lastTicketId: 't1' } })
  assert.equal(syncedDisk.riaPreset, 'standard')
  assert.equal(syncedDisk.createdAt, 11111)
  assert.equal(syncedDisk.lastHumanMessageAt, 99999)
  runtime.close()

  console.log('control state synchronous write ok')
} finally { rmSync(root, { recursive: true, force: true }) }