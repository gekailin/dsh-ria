import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const stateDir = mkdtempSync(join(tmpdir(), 'dsh-ria-test-'))
const installed = new Map()
const prompts = []
let created = false
let riaId = 'session-ria'

const workerEvents = []
const guardSections = []
function recordGuard(agentId, section) {
  guardSections.push({ agentId, section })
  return () => {}
}
const permissions = {
  sandboxMode: 'workspace-write',
  sandboxOverride: undefined,
  approvalPolicy: 'ask',
  approvalOverride: undefined,
}
const worker = {
  id: 'session-worker',
  ctx: { tools: { register: () => () => {} }, systemPrompt: { section(section) { return recordGuard('worker', section) } } },
  session: {
    snapshotEvents: () => [
      { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'worker says done' }] } } },
      { type: 'turn/end', seq: 3, data: { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ],
    append(type, data) {
      workerEvents.push({ type, data })
      if (type === 'sandbox/mode') permissions.sandboxOverride = data.mode
      return { seq: workerEvents.length, time: 1 }
    },
  },
}
const archivedSessionIds = ['session-archived']
const riaEvents = []
let riaTurn = 7
let failRiaSnapshot = false
const riaAgent = {
  id: riaId,
  ctx: {
    tools: { register(definition) { installed.set(definition.name, definition); return () => {} } },
    systemPrompt: {
      section(section) {
        installed.set('prompt:' + section.name, section)
        if (section.name === 'dsh-ria:dispatch-guard') recordGuard('ria', section)
        return () => {}
      },
    },
  },
  session: {
    snapshotEvents() {
      if (failRiaSnapshot) throw new Error('snapshot failed')
      return [{ type: 'turn/start', data: { turn: riaTurn } }, { type: 'step/start', data: { turn: riaTurn, step: 1 } }]
    },
    append(type, data, options) {
      riaEvents.push({ type, data, options })
      return { seq: riaEvents.length - 1, time: 1 }
    },
  },
}

const listeners = new Map()
const effects = []
const failPrompts = new Set()
const workspaceAttachments = []
const workspace = {
  id: 'workspace-ria',
  path: stateDir,
  async attachSession(sessionId) { workspaceAttachments.push(sessionId) },
}
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  agents: { list() { return [worker] } },
  on(name, handler) {
    const list = listeners.get(name) || []
    list.push(handler)
    listeners.set(name, list)
    return () => {
      const current = listeners.get(name) || []
      const index = current.indexOf(handler)
      if (index >= 0) current.splice(index, 1)
    }
  },
  effect(factory) { const dispose = factory(); if (dispose) effects.push(dispose); return dispose },
  webServer: {
    register(route) { ctx.route = route; return () => {} },
  },
  workspaceRegistry: {
    get archivedSessionIds() { return archivedSessionIds },
    async create(path, title) {
      assert.equal(path, stateDir)
      assert.equal(title, 'Ria')
      return workspace
    },
  },
  sandboxPolicy: {
    resolve(request) {
      assert.equal(request.session, worker.session)
      return { mode: permissions.sandboxOverride ?? permissions.sandboxMode }
    },
    overrideOf(session) {
      assert.equal(session, worker.session)
      return permissions.sandboxOverride
    },
  },
  approval: {
    effectivePolicy(session) {
      assert.equal(session, worker.session)
      return permissions.approvalOverride ?? permissions.approvalPolicy
    },
    overrideOf(session) {
      assert.equal(session, worker.session)
      return permissions.approvalOverride
    },
    setPolicy(agent, policy) {
      assert.equal(agent, worker)
      permissions.approvalOverride = policy
      workerEvents.push({ type: 'approval/policy', data: { policy } })
    },
  },
  sessionController: {
    async create(request) {
      assert.equal(request.workspaceId, workspace.id)
      assert.equal(request.cwd, undefined)
      created = true
      riaId = String(request.sessionId)
      riaAgent.id = riaId
      for (const listener of [...(listeners.get('agent/created') || [])]) await listener({ agent: riaAgent })
      await workspace.attachSession(riaId)
      return { sessionId: riaId, agentPreset: request.agentPreset }
    },
    async resolveAgent(id) {
      const value = String(id)
      if (value === riaId) return { agent: riaAgent }
      if (value === 'session-worker') return { agent: worker }
      // The writer-held path forces ria_read to fall back to sessionController.events().
      if (value === 'session-seeded') return { error: { code: 'session/writer-held', message: 'held by another writer' } }
      return { error: { code: 'session/not-found', message: 'not found' } }
    },
    async list() {
      return { items: [
        { sessionId: riaId, running: false, blank: false, updatedAt: 1, cwd: stateDir },
        { sessionId: 'session-worker', running: true, blank: false, updatedAt: 2, cwd: stateDir, projections: { values: { title: 'Worker One' } } },
        { sessionId: 'session-child', running: false, blank: false, updatedAt: 3, cwd: '/tmp', parentSessionId: 'session-worker', origin: 'subagent' },
        { sessionId: 'session-worker-2', running: false, blank: true, updatedAt: 4, projections: { values: { title: 'Worker Two' } } },
        { sessionId: 'session-archived', running: false, blank: false, updatedAt: 5, cwd: stateDir, projections: { values: { title: 'Archived One' } } },
        { sessionId: 'session-no-workspace', running: false, blank: false, updatedAt: 6, cwd: '/work/worker-gone', projections: { values: { title: 'Gone One' } } },
        // Seeded session: has parentSessionId but no origin; it is a top-level worker.
        { sessionId: 'session-seeded', running: false, blank: false, updatedAt: 7, cwd: stateDir, parentSessionId: 'session-worker', projections: { values: { title: 'Seeded One' } } },
      ] }
    },
    async prompt(request) {
      prompts.push(request)
      if (failPrompts.has(String(request.sessionId))) throw new Error('prompt failed')
      return { accepted: true }
    },
    async state() { return { cursor: 1, active: false, running: true, queue: 0, pendingInput: [] } },
    async events(request) {
      if (request.address && request.address.sessionId === 'session-seeded') {
        return {
          records: [
            { type: 'event', event: { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'cold worker says done' }] } } } },
            { type: 'event', event: { type: 'turn/end', seq: 3, data: { turn: 2, reason: { kind: 'completed' } } } },
          ],
          hasMore: false,
          cursor: 4,
        }
      }
      return { records: [], hasMore: false, cursor: 0 }
    },
    async rename() { return { title: 'Ria', seq: 1 } },
  },
}

function assertLossless(value, path = '$') {
  if (value === undefined) throw new Error(path + ' is undefined')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(path + ' is not a finite number')
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new Error(path + ' is not JSON data')
  if (value && typeof value === 'object') {
    if (Object.prototype.toString.call(value) === '[object Date]') throw new Error(path + ' is a Date')
    if (Array.isArray(value)) value.forEach((item, index) => assertLossless(item, path + '[' + index + ']'))
    else for (const [key, item] of Object.entries(value)) assertLossless(item, path + '.' + key)
  }
  JSON.stringify(value)
}

const service = apply(ctx, { stateDir })
const wechatNotes = []
service.wechat.sendDispatchNote = async (note, options) => {
  wechatNotes.push({ note, options })
  return true
}

function request(method, path, payload) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = { host: '127.0.0.1:3080' }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(body) { this.body = body; this.done(body) },
  }
  const done = new Promise(resolve => { res.done = resolve })
  ctx.route.handler(req, res)
  setImmediate(() => {
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
  })
  return done.then(body => ({ status: res.statusCode, body: JSON.parse(body) }))
}

const ensured = await request('POST', '/plugins/dsh-ria/api/ensure')
assert.equal(ensured.status, 200)
assert.equal(ensured.body.sessionId, riaId)
assert.equal(created, true)
assert.deepEqual(workspaceAttachments, [riaId])
// The welcome is client-side: creating Ria must not write a synthetic turn
// into the session log, or the stored log fails v4 validation on resume.
assert.deepEqual(riaEvents, [])
const initialSettings = await request('GET', '/plugins/dsh-ria/api/settings')
assert.equal(initialSettings.status, 200)
assert.deepEqual(initialSettings.body, { dispatchGuard: true, progressCards: false })
assertLossless(initialSettings.body)
const workerGuard = guardSections.find(item => item.agentId === 'worker')
const riaGuard = guardSections.find(item => item.agentId === 'ria')
assert.ok(workerGuard && riaGuard)
assert.match(workerGuard.section.text(), /ask the user to confirm/)
assert.doesNotMatch(workerGuard.section.text(), /\bRia\b/i)
assert.match(workerGuard.section.text(), /clearly unrelated/)
assert.equal(riaGuard.section.text(), workerGuard.section.text())
const guardOff = await request('POST', '/plugins/dsh-ria/api/settings', { dispatchGuard: false })
assert.equal(guardOff.status, 200)
assert.deepEqual(guardOff.body, { dispatchGuard: false, progressCards: false })
assert.equal(workerGuard.section.text(), '')
assert.equal(riaGuard.section.text(), '')
const guardOn = await request('POST', '/plugins/dsh-ria/api/settings', { dispatchGuard: true })
assert.equal(guardOn.status, 200)
assert.deepEqual(guardOn.body, { dispatchGuard: true, progressCards: false })
assert.match(workerGuard.section.text(), /ask the user to confirm/)
assert.doesNotMatch(workerGuard.section.text(), /\bRia\b/i)
const badGuard = await request('POST', '/plugins/dsh-ria/api/settings', { dispatchGuard: 'yes' })
assert.equal(badGuard.status, 400)
const reopened = await request('POST', '/plugins/dsh-ria/api/ensure')
assert.equal(reopened.body.created, false)
assert.equal(riaEvents.length, 0)
assert.deepEqual(workspaceAttachments, [riaId, riaId])
assert.ok(installed.has('ria_task'))
assert.ok(installed.has('ria_status'))
assert.ok(installed.has('ria_request'))
assert.ok(installed.has('ria_read'))
assert.ok(installed.has('ria_memory'))
assert.ok(installed.has('ria_approval'))
assert.ok(installed.has('ria_grant'))
assert.ok(installed.has('prompt:ria-manager'))

let concluded = 0
const call = async (name, args) => installed.get(name).execute(args, {
  agent: riaAgent,
  signal: new AbortController().signal,
  concludeTurn() { concluded += 1 },
})
const recentEmpty = await call('ria_status', { scope: 'recent' })
assert.deepEqual(recentEmpty.workers, [])
assert.equal(recentEmpty.windowDays, 7)
assert.equal(recentEmpty.limit, 5)
assertLossless(recentEmpty)

const task = await call('ria_task', { goal: 'fix tests', acceptance: 'green', executor: 'session-worker' })
assert.equal(task.task.taskId.startsWith('task_'), true)
concluded = 0
const promptsBeforeNoteErrors = prompts.length
await assert.rejects(
  () => call('ria_request', { targetSessionIds: ['session-worker'], message: 'no note', taskId: task.task.taskId }),
  /requires a non-empty note/,
)
await assert.rejects(
  () => call('ria_request', { targetSessionIds: ['session-worker'], message: 'blank note', taskId: task.task.taskId, note: '   ' }),
  /requires a non-empty note/,
)
await assert.rejects(
  () => call('ria_request', { targetSessionIds: ['session-worker'], message: 'long note', taskId: task.task.taskId, note: 'x'.repeat(501) }),
  /maximum is 500/,
)
assert.equal(prompts.length, promptsBeforeNoteErrors)
assert.equal(concluded, 0)
const eventsBeforeTaskDispatch = riaEvents.length
const dispatchNote = '已把“修复测试”交给 Worker One，请它先检查现有用例；完成后我会向你汇报。'
const requestResult = await call('ria_request', { targetSessionIds: ['session-worker'], message: 'please fix', taskId: task.task.taskId, note: dispatchNote })
assert.equal(requestResult.results[0].ok, true)
assert.equal(concluded, 1)
assert.equal(prompts.at(-1).content.length, 1)
assert.equal(prompts.at(-1).content[0].text, 'please fix')
assert.equal(prompts.at(-1).requestId.startsWith('req_'), true)
assert.equal(riaEvents.length, eventsBeforeTaskDispatch)
const notesAtTurn = await request('GET', '/plugins/dsh-ria/api/dispatch-notes?sessionId=' + encodeURIComponent(riaId) + '&turn=' + riaTurn)
assert.equal(notesAtTurn.status, 200)
assert.equal(notesAtTurn.body.notes.length, 1)
const storedNote = notesAtTurn.body.notes[0]
assert.equal(storedNote.turn, riaTurn)
assert.equal(storedNote.sessionId, riaId)
assert.equal(storedNote.note, dispatchNote)
assert.equal(storedNote.isTask, true)
assert.equal(storedNote.taskId, task.task.taskId)
assert.equal(typeof storedNote.at, 'number')
assertLossless(notesAtTurn.body)
assert.deepEqual(wechatNotes, [{ note: dispatchNote, options: { isTask: true } }])
const notesWrongSession = await request('GET', '/plugins/dsh-ria/api/dispatch-notes?sessionId=session-worker&turn=' + riaTurn)
assert.deepEqual(notesWrongSession.body, { notes: [] })
const notesAll = await request('GET', '/plugins/dsh-ria/api/dispatch-notes?sessionId=' + encodeURIComponent(riaId))
assert.equal(notesAll.body.notes.length, 1)
const persistedState = JSON.parse(readFileSync(join(stateDir, 'ria.json'), 'utf8'))
assert.equal(persistedState.dispatchNotes.length, 1)
assert.equal(persistedState.dispatchNotes[0].note, dispatchNote)
const recentAfterTask = await call('ria_status', { scope: 'recent' })
assert.equal(recentAfterTask.workers.length, 1)
assert.equal(recentAfterTask.workers[0].sessionId, 'session-worker')
assert.equal(recentAfterTask.workers[0].title, 'Worker One')
assert.equal(recentAfterTask.workers[0].cwd, stateDir)
assert.equal(recentAfterTask.workers[0].lastTaskId, task.task.taskId)
assert.equal(recentAfterTask.workers[0].lastTaskGoal, 'fix tests')
assert.equal(recentAfterTask.workers[0].lastTaskStatus, 'working')
assert.equal(typeof recentAfterTask.workers[0].lastUsedAt, 'number')
assertLossless(recentAfterTask)
const lastUsedBeforeQuick = recentAfterTask.workers[0].lastUsedAt
concluded = 0
const eventsBeforeQuick = riaEvents.length
const quickRequest = await call('ria_request', { targetSessionIds: ['session-worker'], message: 'just checking' })
assert.equal(quickRequest.results[0].ok, true)
assert.equal('taskId' in quickRequest.results[0], false)
assert.equal(concluded, 1)
assert.equal(prompts.at(-1).content.length, 1)
assert.equal(prompts.at(-1).content[0].text, 'just checking')
assert.equal(riaEvents.length, eventsBeforeQuick)
assert.equal(wechatNotes.length, 1)
assertLossless(quickRequest)
const notesAfterQuick = await request('GET', '/plugins/dsh-ria/api/dispatch-notes?sessionId=' + encodeURIComponent(riaId) + '&turn=' + riaTurn)
assert.equal(notesAfterQuick.body.notes.length, 1)
const quickNote = '只是转述一句话给 Worker One。'
const quickWithNote = await call('ria_request', { targetSessionIds: ['session-worker'], message: 'quick note', note: quickNote })
assert.equal(quickWithNote.results[0].ok, true)
const notesAfterQuickWithNote = await request('GET', '/plugins/dsh-ria/api/dispatch-notes?sessionId=' + encodeURIComponent(riaId) + '&turn=' + riaTurn)
assert.equal(notesAfterQuickWithNote.body.notes.length, 2)
assert.equal(notesAfterQuickWithNote.body.notes[1].isTask, false)
assert.equal(notesAfterQuickWithNote.body.notes[1].note, quickNote)
assert.equal('taskId' in notesAfterQuickWithNote.body.notes[1], false)
assert.deepEqual(wechatNotes[1], { note: quickNote, options: { isTask: false } })
assertLossless(notesAfterQuickWithNote.body)
const recentAfterQuick = await call('ria_status', { scope: 'recent' })
assert.equal(recentAfterQuick.workers.length, 1)
assert.equal(recentAfterQuick.workers[0].lastUsedAt >= lastUsedBeforeQuick, true)
assert.equal(recentAfterQuick.workers[0].lastTaskId, task.task.taskId)
assertLossless(recentAfterQuick)
concluded = 0
const eventsBeforeSnapshotFailure = riaEvents.length
const notesBeforeSnapshotFailure = (await request('GET', '/plugins/dsh-ria/api/dispatch-notes?sessionId=' + encodeURIComponent(riaId))).body.notes.length
failRiaSnapshot = true
let snapshotFailure
try {
  snapshotFailure = await call('ria_request', { targetSessionIds: ['session-worker'], message: 'note display failure', taskId: task.task.taskId, note: '展示失败也要继续派发。' })
} finally {
  failRiaSnapshot = false
}
assert.equal(snapshotFailure.results[0].ok, true)
assert.equal(concluded, 1)
assert.equal(riaEvents.length, eventsBeforeSnapshotFailure)
const notesAfterSnapshotFailure = await request('GET', '/plugins/dsh-ria/api/dispatch-notes?sessionId=' + encodeURIComponent(riaId))
assert.equal(notesAfterSnapshotFailure.body.notes.length, notesBeforeSnapshotFailure)
assert.deepEqual(wechatNotes[2], { note: '展示失败也要继续派发。', options: { isTask: true } })
assertLossless(snapshotFailure)
const originalSendDispatchNote = service.wechat.sendDispatchNote
service.wechat.sendDispatchNote = async () => { throw new Error('wechat unavailable') }
concluded = 0
const wechatFailure = await call('ria_request', { targetSessionIds: ['session-worker'], message: 'wechat note failure', taskId: task.task.taskId, note: '微信发送失败也要继续派发。' })
assert.equal(wechatFailure.results[0].ok, true)
assert.equal(concluded, 1)
await new Promise(resolve => setImmediate(resolve))
service.wechat.sendDispatchNote = originalSendDispatchNote
assertLossless(wechatFailure)
concluded = 0
const partialRequest = await call('ria_request', { targetSessionIds: ['session-worker', 'session-child'], message: 'partial' })
assert.equal(partialRequest.results.filter(item => item.ok).length, 1)
assert.equal(concluded, 0)
assertLossless(partialRequest)
const approvals = await call('ria_approval', {})
assert.deepEqual(approvals, { pending: [], count: 0 })
assertLossless(approvals)
const status = await call('ria_status', { scope: 'tasks' })
assert.equal(status.tasks[0].status, 'working')
assertLossless(status)
const sessions = await call('ria_status', { scope: 'sessions' })
assert.deepEqual(sessions.sessions.map(item => item.sessionId), ['session-worker', 'session-worker-2', 'session-archived', 'session-no-workspace', 'session-seeded'])
assertLossless(sessions)
assert.equal('parentSessionId' in sessions.sessions[0], false)
assert.equal(sessions.sessions[0].title, 'Worker One')
assert.equal(sessions.sessions[0].cwd, stateDir)
assert.equal(sessions.sessions[0].archived, false)
assert.equal(sessions.sessions[2].archived, true)
assert.equal(typeof sessions.sessions[0].lastUsedAt, 'number')
assert.equal(sessions.sessions[1].title, 'Worker Two')
assert.equal('cwd' in sessions.sessions[1], false)
assert.equal('lastUsedAt' in sessions.sessions[1], false)
assert.equal(sessions.sessions[4].parentSessionId, 'session-worker')
// A seeded session keeps a parentSessionId; it must still be dispatchable.
concluded = 0
const seededDispatch = await call('ria_request', { targetSessionIds: ['session-seeded'], message: 'seeded worker check' })
assert.equal(seededDispatch.results[0].ok, true)
assert.equal(concluded, 1)
assert.equal(prompts.at(-1).sessionId, 'session-seeded')
assertLossless(seededDispatch)
const sessionStatus = await call('ria_status', { scope: 'sessions', sessionId: 'session-worker' })
assert.equal(sessionStatus.session.sessionId, 'session-worker')
assertLossless(sessionStatus)

// Dispatch preflight: archived, missing-workspace, and missing-session targets
// are rejected before delivery and leave task/recent-worker state untouched.
concluded = 0
const preflightPromptsBefore = prompts.length
const archivedTask = await call('ria_task', { goal: 'archived target', acceptance: 'never runs', executor: 'session-archived' })
const archivedDispatch = await call('ria_request', {
  targetSessionIds: ['session-archived'],
  message: 'should not arrive',
  taskId: archivedTask.task.taskId,
  note: '不会真的派发。',
})
assert.equal(archivedDispatch.results[0].ok, false)
assert.equal(archivedDispatch.results[0].code, 'session_archived')
assert.equal(archivedDispatch.results[0].taskId, archivedTask.task.taskId)
assert.match(archivedDispatch.results[0].message, /session-archived/)
assert.equal(prompts.length, preflightPromptsBefore)
assert.equal(concluded, 0)
assertLossless(archivedDispatch)
const tasksAfterArchived = await call('ria_status', { scope: 'tasks' })
assert.equal(tasksAfterArchived.tasks.find(item => item.taskId === archivedTask.task.taskId).status, 'open')
const recentAfterArchived = await call('ria_status', { scope: 'recent' })
assert.equal(recentAfterArchived.workers.some(item => item.sessionId === 'session-archived'), false)

const noWorkspaceDispatch = await call('ria_request', { targetSessionIds: ['session-no-workspace'], message: 'nope' })
assert.equal(noWorkspaceDispatch.results[0].ok, false)
assert.equal(noWorkspaceDispatch.results[0].code, 'workspace_missing')
assert.match(noWorkspaceDispatch.results[0].message, /session-no-workspace/)
assert.match(noWorkspaceDispatch.results[0].message, /工作目录/)
assert.equal(prompts.length, preflightPromptsBefore)
assert.equal(concluded, 0)

const missingDispatch = await call('ria_request', { targetSessionIds: ['session-nope'], message: 'nope' })
assert.equal(missingDispatch.results[0].ok, false)
assert.equal(missingDispatch.results[0].code, 'session_missing')
assert.match(missingDispatch.results[0].message, /session-nope/)
assert.equal(prompts.length, preflightPromptsBefore)

const mixedPromptsBefore = prompts.length
const mixed = await call('ria_request', {
  targetSessionIds: ['session-worker', 'session-archived', 'session-no-workspace', 'session-nope'],
  message: 'mixed',
})
assert.equal(mixed.results[0].ok, true)
assert.deepEqual(mixed.results.slice(1).map(item => item.code), ['session_archived', 'workspace_missing', 'session_missing'])
assert.equal(prompts.length, mixedPromptsBefore + 1)
assert.equal(prompts.at(-1).sessionId, 'session-worker')
assert.equal(concluded, 0)
assertLossless(mixed)
const read = await call('ria_read', { sessionId: 'session-worker', limit: 10 })
assert.equal(read.messages[0].text, 'worker says done')
assert.deepEqual(read.lastTurn, { outcome: 'aborted(user)', turn: 4 })
const coldRead = await call('ria_read', { sessionId: 'session-seeded', limit: 10 })
assert.equal(coldRead.live, false)
assert.equal(coldRead.messages[0].text, 'cold worker says done')
assert.deepEqual(coldRead.lastTurn, { outcome: 'completed', turn: 2 })
await assert.rejects(
  () => call('ria_grant', { action: 'set', sessionId: 'session-worker', sandboxMode: 'danger-full-access' }),
  /userConfirmed=true/,
)
const grant = await call('ria_grant', {
  action: 'set',
  sessionId: 'session-worker',
  taskId: task.task.taskId,
  sandboxMode: 'danger-full-access',
  approvalPolicy: 'never',
  ttlSeconds: 600,
  reason: 'test grant',
  userConfirmed: true,
})
assert.equal(grant.grant.sessionId, 'session-worker')
assert.equal(grant.grant.before.sandboxMode, 'workspace-write')
assert.equal(grant.grant.before.sandboxOverride, null)
assert.equal(grant.grant.before.approvalPolicy, 'ask')
assert.equal(grant.grant.after.sandboxMode, 'danger-full-access')
assert.equal(grant.grant.after.approvalPolicy, 'never')
assert.equal(permissions.sandboxOverride, 'danger-full-access')
assert.equal(permissions.approvalOverride, 'never')
assertLossless(grant)
const activeGrants = await call('ria_grant', { action: 'list' })
assert.equal(activeGrants.count, 1)
assert.equal(activeGrants.grants[0].grantId, grant.grant.grantId)
assertLossless(activeGrants)
const paused = await request('POST', '/plugins/dsh-ria/api/wechat/pause', { paused: true, reason: 'smoke' })
assert.equal(paused.status, 200)
assert.equal(paused.body.paused, true)
assert.equal(paused.body.pausedBy, 'manual')
assert.equal(paused.body.pauseReason, 'smoke')
assert.equal(typeof paused.body.pausedAt, 'string')
assert.ok(!Number.isNaN(Date.parse(paused.body.pausedAt)))
assert.equal(paused.body.resumedAt, null)
const pausedStatus = await request('GET', '/plugins/dsh-ria/api/wechat/status')
assert.equal(pausedStatus.body.paused, true)
assert.equal(pausedStatus.body.pausedBy, 'manual')
assert.equal(pausedStatus.body.pausedAt, paused.body.pausedAt)
assert.equal(pausedStatus.body.pauseReason, 'smoke')
const resumed = await request('POST', '/plugins/dsh-ria/api/wechat/pause', { paused: false })
assert.equal(resumed.status, 200)
assert.equal(resumed.body.paused, false)
assert.equal(resumed.body.pausedBy, null)
assert.equal(resumed.body.pausedAt, null)
assert.equal(typeof resumed.body.resumedAt, 'string')
assert.equal(resumed.body.resumedBy, 'manual')
const resumedStatus = await request('GET', '/plugins/dsh-ria/api/wechat/status')
assert.equal(resumedStatus.body.paused, false)
assert.equal(resumedStatus.body.pausedBy, null)
assert.equal(resumedStatus.body.pausedAt, null)
const badPause = await request('POST', '/plugins/dsh-ria/api/wechat/pause', { paused: 'yes' })
assert.equal(badPause.status, 400)
const httpState = await request('GET', '/plugins/dsh-ria/api/state')
assert.equal(httpState.status, 200)
assert.equal(httpState.body.grants.length, 1)
assert.equal(httpState.body.grants[0].grantId, grant.grant.grantId)
assert.deepEqual(httpState.body.settings, { dispatchGuard: true, progressCards: false })
const closedTask = await call('ria_task', { taskId: task.task.taskId, status: 'done' })
assert.equal(closedTask.task.status, 'done')
assert.equal(permissions.sandboxOverride, 'workspace-write')
assert.equal(permissions.approvalOverride, 'ask')
const restoredGrants = await call('ria_grant', { action: 'list' })
assert.equal(restoredGrants.count, 0)
assertLossless(restoredGrants)
const secondGrant = await call('ria_grant', {
  action: 'set',
  sessionId: 'session-worker',
  approvalPolicy: 'never',
  ttlSeconds: 600,
  userConfirmed: true,
})
assert.equal(permissions.approvalOverride, 'never')
const reset = await call('ria_grant', { action: 'reset', grantId: secondGrant.grant.grantId })
assert.equal(reset.restored, true)
assert.deepEqual(reset.restoredFields, ['approvalPolicy'])
assert.equal(permissions.approvalOverride, 'ask')
assertLossless(reset)
await assert.rejects(
  () => call('ria_grant', { action: 'reset', grantId: secondGrant.grant.grantId }),
  /grant not found/,
)
const audit = readFileSync(join(stateDir, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
assert.ok(audit.some(item => item.event === 'grant/set' && item.grantId === grant.grant.grantId))
assert.ok(audit.some(item => item.event === 'grant/restored' && item.trigger === 'task-done'))
assert.ok(audit.some(item => item.event === 'grant/restored' && item.trigger === 'explicit-reset'))
await call('ria_memory', { action: 'remember', key: 'language', text: 'Chinese' })
const memory = await call('ria_memory', { action: 'read' })
assert.match(memory.text, /language/)
const promptText = installed.get('prompt:ria-manager').text()
assert.match(promptText, /Chinese/)
assert.match(promptText, /Ria session id/)
assert.match(promptText, /End the current turn immediately/)
assert.match(promptText, /Every request the user hands you must be carried to an end/)
assert.match(promptText, /call ria_resolve once per listed ticket/)
assert.match(promptText, /Never use ria_task to edit an intake/)
assert.match(promptText, /When a worker refuses a task, or the user cancels\/stops a worker turn/)
assert.match(promptText, /Never silently reassign the work, re-send it, or switch to another approach on your own/)
assert.match(promptText, /mark the task blocked with blockedReason and wait for instructions/)
assert.match(promptText, /who received the task/)
assert.match(promptText, /what the user will see next/)
assert.match(promptText, /MUST include note/)
assert.match(promptText, /quick relay without taskId does not need note/)
assert.match(promptText, /do not rely on assistant text/)
assert.match(installed.get('ria_status').description, /never waits/)
assert.match(installed.get('ria_status').description, /scope=recent/)
assert.match(installed.get('ria_status').description, /lastUsedAt/)
assert.match(installed.get('ria_status').description, /lastTaskGoal/)
assert.match(installed.get('ria_read').description, /lastTurn/)
assert.match(installed.get('ria_read').description, /aborted\(user\)/)
assert.match(installed.get('ria_request').description, /ends the current turn/)
assert.match(installed.get('ria_request').description, /anti-misdelivery constraint/)
assert.match(installed.get('ria_request').description, /adds no message prefix/)
assert.match(installed.get('ria_request').description, /note is REQUIRED/)
assert.match(installed.get('ria_request').description, /missing, blank, or over-500-character note is an error/)
assert.match(installed.get('ria_request').description, /who received the task/)
assert.match(installed.get('ria_request').description, /what the user will see next/)
assert.match(installed.get('ria_request').description, /maximum 500 characters/i)
assert.match(installed.get('ria_approval').description, /never approves or denies/)
assert.match(promptText, /anti-misdelivery constraint/)
assert.match(promptText, /does not add any prefix/)
assert.match(promptText, /\[Worker idle\]/)
assert.match(promptText, /ria_approval/)
assert.match(promptText, /ria_grant/)
assert.match(installed.get('ria_grant').description, /explicitly asks/)
assert.doesNotMatch(promptText, /welcome/i)
assert.match(promptText, /scope="recent"/)
assert.match(promptText, /up to 5 workers/)
assert.match(promptText, /last 7 days/)
assert.match(promptText, /ask the user which session/)
assert.match(promptText, /Creating or updating a task does not count/)
assert.match(promptText, /ria_spawn/)
assert.match(promptText, /absolute directory/)
assert.match(promptText, /attachments/)
assert.match(promptText, /target model accepts image input/)
assert.ok(installed.has('ria_spawn'))

const state = JSON.parse(readFileSync(join(stateDir, 'ria.json'), 'utf8'))
assert.equal(state.riaSessionId, riaId)
assert.equal(state.tickets[0].goal, 'fix tests')
assert.equal(state.deliveries.length, 0)
assert.equal(state.grants.length, 0)
assert.equal(typeof state.recentWorkers['session-worker'].lastUsedAt, 'number')
assert.equal(state.recentWorkers['session-worker'].lastTaskId, task.task.taskId)
assert.equal('session-worker-2' in state.recentWorkers, false)

const beforeFailedUse = (await call('ria_status', { scope: 'recent' })).workers[0].lastUsedAt
failPrompts.add('session-worker')
concluded = 0
const failedRequest = await call('ria_request', { targetSessionIds: ['session-worker'], message: 'do not deliver' })
assert.equal(failedRequest.results[0].ok, false)
assert.equal('taskId' in failedRequest.results[0], false)
assert.match(failedRequest.results[0].error, /prompt failed/)
assert.equal(concluded, 0)
assertLossless(failedRequest)
const afterFailedUse = await call('ria_status', { scope: 'recent' })
assert.equal(afterFailedUse.workers[0].lastUsedAt, beforeFailedUse)
assertLossless(afterFailedUse)
failPrompts.delete('session-worker')

for (const dispose of effects) dispose()
rmSync(stateDir, { recursive: true, force: true })
console.log('smoke ok')
