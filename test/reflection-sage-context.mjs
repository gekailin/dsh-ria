import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSageContext } from '../lib/reflection-sage-context.mjs'
import { RiaService } from '../lib/index.js'
import { openDatabase } from '../lib/state/sqlite/db.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-sage-context-'))
try {
  const state = join(root, 'state')
  mkdirSync(state, { recursive: true })
  const db = openDatabase(join(state, 'ria.sqlite'), { create: true })
  try {
    const insertEntry = db.prepare('INSERT INTO cognition_entries(id,scope,kind,status,tags,body,cause,sources,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    insertEntry.run('cog_1', 'principle', 'preference', 'active', '[]', 'old rule', 'cause', '[]', 'sage', Date.parse('2026-11-20T00:00:00Z'), Date.parse('2026-11-20T00:00:00Z'))
    insertEntry.run('cog_2', 'principle', 'preference', 'active', '[]', 'new rule', 'cause', '[]', 'sage', Date.parse('2026-11-23T00:00:00Z'), Date.parse('2026-11-23T00:00:00Z'))
    insertEntry.run('cog_3', 'user:preference', 'preference', 'active', '[]', 'prefer concise reports', 'cause', '[]', 'sage', Date.parse('2026-11-23T00:00:00Z'), Date.parse('2026-11-23T00:00:00Z'))
    const insertProp = db.prepare('INSERT INTO cognition_proposals(id,author,source,kind,scope,body,cause,sources,priority,status,decided_by,decided_at,rationale,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    insertProp.run('p1', 'executor', 't', 'add', 'global', 'pending proposal', '', '[]', 'normal', 'pending', null, null, null, Date.parse('2026-11-23T01:00:00Z'))
    insertProp.run('p2', 'executor', 't', 'add', 'global', 'accepted proposal', '', '[]', 'normal', 'accepted', null, Date.parse('2026-11-23T02:00:00Z'), null, Date.parse('2026-11-22T01:00:00Z'))
    insertProp.run('p3', 'executor', 't', 'add', 'global', 'rejected proposal', '', '[]', 'normal', 'rejected', 'sage', Date.parse('2026-11-21T02:00:00Z'), 'no', Date.parse('2026-11-21T01:00:00Z'))
    insertProp.run('p4', 'executor', 't', 'add', 'global', 'deferred proposal', '', '[]', 'normal', 'deferred', 'sage', Date.parse('2026-11-23T03:00:00Z'), 'wait for evidence', Date.parse('2026-11-22T01:00:00Z'))
    insertProp.run('p5', 'executor', 't', 'add', 'global', 'accepted but 暂缓 later', '', '[]', 'normal', 'accepted', 'sage', Date.parse('2026-11-23T04:00:00Z'), 'keep', Date.parse('2026-11-22T02:00:00Z'))
  } finally { db.close() }

  const events = [{ type: 'turn/start', time: 1 }, { type: 'assistant/message', time: 2 }, { type: 'tool/result', time: 3 }, { type: 'approval/request', time: 4 }]
  const full = readSageContext(state, { since: '2026-11-22T00:00:00Z', maxChars: 20000, events, sageSessionId: 'sage-1', now: Date.parse('2026-11-23T12:00:00Z') })
  assert.ok(full.cognitionSnapshot && full.pendingProposals && full.decisionHistory && full.sageActivity)
  assert.equal(full.pendingProposals.items.length, 1)
  assert.equal(full.pendingProposals.items[0].id, 'p1')
  assert.equal(full.decisionHistory.items.length, 3)
  const decisionById = new Map(full.decisionHistory.items.map(item => [item.id, item]))
  assert.equal(decisionById.get('p2').decidedBy, null)
  assert.equal(decisionById.get('p2').recorded, 'partial')
  assert.equal(decisionById.get('p3'), undefined, 'rejected before since is excluded')
  assert.equal(decisionById.get('p4').status, 'deferred')
  assert.equal(decisionById.get('p4').decidedBy, 'sage')
  assert.equal(decisionById.get('p4').rationale, 'wait for evidence')
  assert.equal(decisionById.get('p4').recorded, 'complete')
  assert.equal(decisionById.get('p5').status, 'accepted')
  assert.match(decisionById.get('p5').warning, /deferred\/pending/)
  assert.equal(full.decisionHistory.warnings.length, 1)
  assert.equal(full.decisionHistory.warnings[0].id, 'p5')
  assert.equal(full.decisionHistory.recorded, 'partial')
  assert.equal(full.sageActivity.counts.turns, 1)
  assert.equal(full.counts.pendingProposals, 1)
  assert.equal(full.truncated, false)
  assert.equal(full.cognitionSnapshot.files.find(file => file.file === 'cognition_entries/principle').items.length, 1, 'since excludes old entry')

  const tiny = readSageContext(state, { since: '2026-11-22T00:00:00Z', maxChars: 80, events, sageSessionId: 'sage-1' })
  assert.equal(tiny.truncated, true)

  const empty = readSageContext(join(root, 'empty'), { since: 0, maxChars: 20000 })
  assert.equal(empty.counts.files, 0)
  assert.equal(empty.pendingProposals.items.length, 0)
  assert.equal(empty.decisionHistory.recorded, '无记录')
  assert.equal(empty.truncated, false)

  // Verify toolReflectReadSageContext resolves sageSessionId from controller.state (not empty RiaStore.data).
  const fakeService = Object.create(RiaService.prototype)
  fakeService.stateDir = state
  fakeService.log = () => {}
  fakeService.store = { data: {} }
  fakeService.reflectionRunFor = () => ({ runId: 'r1', status: 'running', sageContextRead: true })
  fakeService.reflectionClosed = () => ({ ok: false, code: 'run_closed' })
  let requestedSessionId = null
  fakeService.controller = {
    state: { sageSessionId: 'session-sage-from-state' },
    cognition: null,
    sessionEvents: async opts => {
      requestedSessionId = opts.sessionId
      return { ok: true, events: [{ type: 'turn/start', time: Date.parse('2026-11-23T05:00:00Z') }] }
    },
  }
  const viaTool = await RiaService.prototype.toolReflectReadSageContext.call(fakeService, 'exec-1', 'r1', { since: '2026-11-22T00:00:00Z' }, {})
  assert.equal(requestedSessionId, 'session-sage-from-state')
  assert.equal(viaTool.sageActivity.available, true)
  assert.equal(viaTool.sageActivity.sessionId, 'session-sage-from-state')
  assert.equal(viaTool.sageActivity.counts.turns, 1)

  console.log('reflection sage context ok')
} finally { rmSync(root, { recursive: true, force: true }) }
