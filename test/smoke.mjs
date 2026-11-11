import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const stateDir = mkdtempSync(join(tmpdir(), 'dsh-super-session-test-'))
const installed = new Map()
const prompts = []
let created = false
let superId = 'session-super'

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
    snapshotEvents: () => [{ type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'worker says done' }] } } }],
    append(type, data) {
      workerEvents.push({ type, data })
      if (type === 'sandbox/mode') permissions.sandboxOverride = data.mode
      return { seq: workerEvents.length, time: 1 }
    },
  },
}
const superEvents = []
let failSuperAppend = false
const superAgent = {
  id: superId,
  ctx: {
    tools: { register(definition) { installed.set(definition.name, definition); return () => {} } },
    systemPrompt: {
      section(section) {
        installed.set('prompt:' + section.name, section)
        if (section.name === 'dsh-super-session:dispatch-guard') recordGuard('super', section)
        return () => {}
      },
    },
  },
  session: {
    snapshotEvents: () => [],
    append(type, data, options) {
      if (failSuperAppend) throw new Error('append failed')
      superEvents.push({ type, data, options })
      return { seq: superEvents.length - 1, time: 1 }
    },
  },
}

const listeners = new Map()
const effects = []
const failPrompts = new Set()
const workspaceAttachments = []
const workspace = {
  id: 'workspace-super',
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
    async create(path, title) {
      assert.equal(path, stateDir)
      assert.equal(title, 'Super Session')
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
      superId = String(request.sessionId)
      superAgent.id = superId
      for (const listener of [...(listeners.get('agent/created') || [])]) await listener({ agent: superAgent })
      await workspace.attachSession(superId)
      return { sessionId: superId, agentPreset: request.agentPreset }
    },
    async resolveAgent(id) {
      const value = String(id)
      if (value === superId) return { agent: superAgent }
      if (value === 'session-worker') return { agent: worker }
      return { error: { code: 'session/not-found', message: 'not found' } }
    },
    async list() {
      return { items: [
        { sessionId: superId, running: false, blank: false, updatedAt: 1, cwd: stateDir },
        { sessionId: 'session-worker', running: true, blank: false, updatedAt: 2, cwd: '/work/worker', projections: { values: { title: 'Worker One' } } },
        { sessionId: 'session-child', running: false, blank: false, updatedAt: 3, cwd: '/tmp', parentSessionId: 'session-worker', origin: 'subagent' },
        { sessionId: 'session-worker-2', running: false, blank: true, updatedAt: 4, projections: { values: { title: 'Worker Two' } } },
      ] }
    },
    async prompt(request) {
      prompts.push(request)
      if (failPrompts.has(String(request.sessionId))) throw new Error('prompt failed')
      return { accepted: true }
    },
    async state() { return { cursor: 1, active: false, running: true, queue: 0, pendingInput: [] } },
    async events() { return { records: [], hasMore: false, cursor: 0 } },
    async rename() { return { title: 'Super Session', seq: 1 } },
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

apply(ctx, { stateDir })

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

const ensured = await request('POST', '/plugins/dsh-super-session/api/ensure')
assert.equal(ensured.status, 200)
assert.equal(ensured.body.sessionId, superId)
assert.equal(created, true)
assert.deepEqual(workspaceAttachments, [superId])
assert.deepEqual(superEvents.map(event => event.type), ['turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
assert.equal(superEvents[0].data.turn, 0)
assert.equal(superEvents[2].data.turn, 0)
assert.equal(superEvents[2].data.step, 0)
assert.equal(superEvents[2].data.message.role, 'assistant')
assert.equal(superEvents[2].data.message.source.kind, 'model')
assert.equal(superEvents[2].options.surfaceOp, 'append')
assert.match(superEvents[2].data.message.content[0].text, /选择模型/)
assert.match(superEvents[2].data.message.content[0].text, /danger-full-access/)
assert.match(superEvents[2].data.message.content[0].text, /权限设置/)
assert.equal(superEvents[4].data.reason.kind, 'completed')
const initialSettings = await request('GET', '/plugins/dsh-super-session/api/settings')
assert.equal(initialSettings.status, 200)
assert.deepEqual(initialSettings.body, { dispatchGuard: true })
assertLossless(initialSettings.body)
const workerGuard = guardSections.find(item => item.agentId === 'worker')
const superGuard = guardSections.find(item => item.agentId === 'super')
assert.ok(workerGuard && superGuard)
assert.match(workerGuard.section.text(), /任务转交提示/)
assert.match(workerGuard.section.text(), /可能发错.*会话/)
assert.equal(superGuard.section.text(), workerGuard.section.text())
const guardOff = await request('POST', '/plugins/dsh-super-session/api/settings', { dispatchGuard: false })
assert.equal(guardOff.status, 200)
assert.deepEqual(guardOff.body, { dispatchGuard: false })
assert.equal(workerGuard.section.text(), '')
assert.equal(superGuard.section.text(), '')
const guardOn = await request('POST', '/plugins/dsh-super-session/api/settings', { dispatchGuard: true })
assert.equal(guardOn.status, 200)
assert.deepEqual(guardOn.body, { dispatchGuard: true })
assert.match(workerGuard.section.text(), /任务转交提示/)
const badGuard = await request('POST', '/plugins/dsh-super-session/api/settings', { dispatchGuard: 'yes' })
assert.equal(badGuard.status, 400)
const reopened = await request('POST', '/plugins/dsh-super-session/api/ensure')
assert.equal(reopened.body.created, false)
assert.equal(superEvents.length, 5)
assert.deepEqual(workspaceAttachments, [superId, superId])
assert.ok(installed.has('super_session_task'))
assert.ok(installed.has('super_session_status'))
assert.ok(installed.has('super_session_request'))
assert.ok(installed.has('super_session_read'))
assert.ok(installed.has('super_session_memory'))
assert.ok(installed.has('super_session_approval'))
assert.ok(installed.has('super_session_grant'))
assert.ok(installed.has('prompt:super-session-manager'))

let concluded = 0
const call = async (name, args) => installed.get(name).execute(args, {
  agent: superAgent,
  signal: new AbortController().signal,
  concludeTurn() { concluded += 1 },
})
const recentEmpty = await call('super_session_status', { scope: 'recent' })
assert.deepEqual(recentEmpty.workers, [])
assert.equal(recentEmpty.windowDays, 7)
assert.equal(recentEmpty.limit, 5)
assertLossless(recentEmpty)

const task = await call('super_session_task', { goal: 'fix tests', acceptance: 'green', executor: 'session-worker' })
assert.equal(task.task.taskId.startsWith('task_'), true)
concluded = 0
const promptsBeforeNoteErrors = prompts.length
await assert.rejects(
  () => call('super_session_request', { targetSessionIds: ['session-worker'], message: 'no note', taskId: task.task.taskId }),
  /requires a non-empty note/,
)
await assert.rejects(
  () => call('super_session_request', { targetSessionIds: ['session-worker'], message: 'blank note', taskId: task.task.taskId, note: '   ' }),
  /requires a non-empty note/,
)
await assert.rejects(
  () => call('super_session_request', { targetSessionIds: ['session-worker'], message: 'long note', taskId: task.task.taskId, note: 'x'.repeat(501) }),
  /maximum is 500/,
)
assert.equal(prompts.length, promptsBeforeNoteErrors)
assert.equal(concluded, 0)
const eventsBeforeTaskDispatch = superEvents.length
const dispatchNote = '已把“修复测试”交给 Worker One，请它先检查现有用例；完成后我会向你汇报。'
const requestResult = await call('super_session_request', { targetSessionIds: ['session-worker'], message: 'please fix', taskId: task.task.taskId, note: dispatchNote })
assert.equal(requestResult.results[0].ok, true)
assert.equal(concluded, 1)
assert.equal(prompts.at(-1).content.length, 1)
assert.equal(prompts.at(-1).content[0].text, 'please fix')
assert.equal(prompts.at(-1).requestId.startsWith('req_'), true)
assert.equal(superEvents.length, eventsBeforeTaskDispatch + 2)
assert.equal(superEvents[eventsBeforeTaskDispatch].type, 'command/run')
assert.equal(superEvents[eventsBeforeTaskDispatch].data.name, '任务派发')
assert.equal(superEvents[eventsBeforeTaskDispatch].data.source.kind, 'user')
assert.equal(superEvents[eventsBeforeTaskDispatch + 1].type, 'command/done')
assert.equal(superEvents[eventsBeforeTaskDispatch + 1].data.kind, 'success')
assert.equal(superEvents[eventsBeforeTaskDispatch + 1].data.text, dispatchNote + '\n')
assert.equal(superEvents[eventsBeforeTaskDispatch + 1].data.commandId, superEvents[eventsBeforeTaskDispatch].data.commandId)
const recentAfterTask = await call('super_session_status', { scope: 'recent' })
assert.equal(recentAfterTask.workers.length, 1)
assert.equal(recentAfterTask.workers[0].sessionId, 'session-worker')
assert.equal(recentAfterTask.workers[0].title, 'Worker One')
assert.equal(recentAfterTask.workers[0].cwd, '/work/worker')
assert.equal(recentAfterTask.workers[0].lastTaskId, task.task.taskId)
assert.equal(recentAfterTask.workers[0].lastTaskGoal, 'fix tests')
assert.equal(recentAfterTask.workers[0].lastTaskStatus, 'working')
assert.equal(typeof recentAfterTask.workers[0].lastUsedAt, 'number')
assertLossless(recentAfterTask)
const lastUsedBeforeQuick = recentAfterTask.workers[0].lastUsedAt
concluded = 0
const eventsBeforeQuick = superEvents.length
const quickRequest = await call('super_session_request', { targetSessionIds: ['session-worker'], message: 'just checking' })
assert.equal(quickRequest.results[0].ok, true)
assert.equal('taskId' in quickRequest.results[0], false)
assert.equal(concluded, 1)
assert.equal(prompts.at(-1).content.length, 1)
assert.equal(prompts.at(-1).content[0].text, 'just checking')
assert.equal(superEvents.length, eventsBeforeQuick)
assertLossless(quickRequest)
const recentAfterQuick = await call('super_session_status', { scope: 'recent' })
assert.equal(recentAfterQuick.workers.length, 1)
assert.equal(recentAfterQuick.workers[0].lastUsedAt >= lastUsedBeforeQuick, true)
assert.equal(recentAfterQuick.workers[0].lastTaskId, task.task.taskId)
assertLossless(recentAfterQuick)
concluded = 0
const eventsBeforeAppendFailure = superEvents.length
failSuperAppend = true
let appendFailure
try {
  appendFailure = await call('super_session_request', { targetSessionIds: ['session-worker'], message: 'note display failure', taskId: task.task.taskId, note: '展示失败也要继续派发。' })
} finally {
  failSuperAppend = false
}
assert.equal(appendFailure.results[0].ok, true)
assert.equal(concluded, 1)
assert.equal(superEvents.length, eventsBeforeAppendFailure)
assertLossless(appendFailure)
concluded = 0
const partialRequest = await call('super_session_request', { targetSessionIds: ['session-worker', 'session-child'], message: 'partial' })
assert.equal(partialRequest.results.filter(item => item.ok).length, 1)
assert.equal(concluded, 0)
assertLossless(partialRequest)
const approvals = await call('super_session_approval', {})
assert.deepEqual(approvals, { pending: [], count: 0 })
assertLossless(approvals)
const status = await call('super_session_status', { scope: 'tasks' })
assert.equal(status.tasks[0].status, 'working')
assertLossless(status)
const sessions = await call('super_session_status', { scope: 'sessions' })
assert.deepEqual(sessions.sessions.map(item => item.sessionId), ['session-worker', 'session-worker-2'])
assertLossless(sessions)
assert.equal('parentSessionId' in sessions.sessions[0], false)
assert.equal(sessions.sessions[0].title, 'Worker One')
assert.equal(sessions.sessions[0].cwd, '/work/worker')
assert.equal(typeof sessions.sessions[0].lastUsedAt, 'number')
assert.equal(sessions.sessions[1].title, 'Worker Two')
assert.equal('cwd' in sessions.sessions[1], false)
assert.equal('lastUsedAt' in sessions.sessions[1], false)
const sessionStatus = await call('super_session_status', { scope: 'sessions', sessionId: 'session-worker' })
assert.equal(sessionStatus.session.sessionId, 'session-worker')
assertLossless(sessionStatus)
const read = await call('super_session_read', { sessionId: 'session-worker', limit: 10 })
assert.equal(read.messages[0].text, 'worker says done')
await assert.rejects(
  () => call('super_session_grant', { action: 'set', sessionId: 'session-worker', sandboxMode: 'danger-full-access' }),
  /userConfirmed=true/,
)
const grant = await call('super_session_grant', {
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
const activeGrants = await call('super_session_grant', { action: 'list' })
assert.equal(activeGrants.count, 1)
assert.equal(activeGrants.grants[0].grantId, grant.grant.grantId)
assertLossless(activeGrants)
const paused = await request('POST', '/plugins/dsh-super-session/api/wechat/pause', { paused: true, reason: 'smoke' })
assert.equal(paused.status, 200)
assert.equal(paused.body.paused, true)
assert.equal(paused.body.pausedBy, 'manual')
assert.equal(paused.body.pauseReason, 'smoke')
assert.equal(typeof paused.body.pausedAt, 'string')
assert.ok(!Number.isNaN(Date.parse(paused.body.pausedAt)))
assert.equal(paused.body.resumedAt, null)
const pausedStatus = await request('GET', '/plugins/dsh-super-session/api/wechat/status')
assert.equal(pausedStatus.body.paused, true)
assert.equal(pausedStatus.body.pausedBy, 'manual')
assert.equal(pausedStatus.body.pausedAt, paused.body.pausedAt)
assert.equal(pausedStatus.body.pauseReason, 'smoke')
const resumed = await request('POST', '/plugins/dsh-super-session/api/wechat/pause', { paused: false })
assert.equal(resumed.status, 200)
assert.equal(resumed.body.paused, false)
assert.equal(resumed.body.pausedBy, null)
assert.equal(resumed.body.pausedAt, null)
assert.equal(typeof resumed.body.resumedAt, 'string')
assert.equal(resumed.body.resumedBy, 'manual')
const resumedStatus = await request('GET', '/plugins/dsh-super-session/api/wechat/status')
assert.equal(resumedStatus.body.paused, false)
assert.equal(resumedStatus.body.pausedBy, null)
assert.equal(resumedStatus.body.pausedAt, null)
const badPause = await request('POST', '/plugins/dsh-super-session/api/wechat/pause', { paused: 'yes' })
assert.equal(badPause.status, 400)
const httpState = await request('GET', '/plugins/dsh-super-session/api/state')
assert.equal(httpState.status, 200)
assert.equal(httpState.body.grants.length, 1)
assert.equal(httpState.body.grants[0].grantId, grant.grant.grantId)
assert.deepEqual(httpState.body.settings, { dispatchGuard: true })
const closedTask = await call('super_session_task', { taskId: task.task.taskId, status: 'done' })
assert.equal(closedTask.task.status, 'done')
assert.equal(permissions.sandboxOverride, 'workspace-write')
assert.equal(permissions.approvalOverride, 'ask')
const restoredGrants = await call('super_session_grant', { action: 'list' })
assert.equal(restoredGrants.count, 0)
assertLossless(restoredGrants)
const secondGrant = await call('super_session_grant', {
  action: 'set',
  sessionId: 'session-worker',
  approvalPolicy: 'never',
  ttlSeconds: 600,
  userConfirmed: true,
})
assert.equal(permissions.approvalOverride, 'never')
const reset = await call('super_session_grant', { action: 'reset', grantId: secondGrant.grant.grantId })
assert.equal(reset.restored, true)
assert.deepEqual(reset.restoredFields, ['approvalPolicy'])
assert.equal(permissions.approvalOverride, 'ask')
assertLossless(reset)
await assert.rejects(
  () => call('super_session_grant', { action: 'reset', grantId: secondGrant.grant.grantId }),
  /grant not found/,
)
const audit = readFileSync(join(stateDir, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
assert.ok(audit.some(item => item.event === 'grant/set' && item.grantId === grant.grant.grantId))
assert.ok(audit.some(item => item.event === 'grant/restored' && item.trigger === 'task-done'))
assert.ok(audit.some(item => item.event === 'grant/restored' && item.trigger === 'explicit-reset'))
await call('super_session_memory', { action: 'remember', key: 'language', text: 'Chinese' })
const memory = await call('super_session_memory', { action: 'read' })
assert.match(memory.text, /language/)
const promptText = installed.get('prompt:super-session-manager').text()
assert.match(promptText, /Chinese/)
assert.match(promptText, /Super Session id/)
assert.match(promptText, /End the current turn immediately/)
assert.match(promptText, /who received the task/)
assert.match(promptText, /what the user will see next/)
assert.match(promptText, /MUST include note/)
assert.match(promptText, /quick relay without taskId does not need note/)
assert.match(promptText, /do not rely on assistant text/)
assert.match(installed.get('super_session_status').description, /never waits/)
assert.match(installed.get('super_session_status').description, /scope=recent/)
assert.match(installed.get('super_session_status').description, /lastUsedAt/)
assert.match(installed.get('super_session_status').description, /lastTaskGoal/)
assert.match(installed.get('super_session_request').description, /ends the current turn/)
assert.match(installed.get('super_session_request').description, /anti-misdelivery constraint/)
assert.match(installed.get('super_session_request').description, /adds no message prefix/)
assert.match(installed.get('super_session_request').description, /note is REQUIRED/)
assert.match(installed.get('super_session_request').description, /missing, blank, or over-500-character note is an error/)
assert.match(installed.get('super_session_request').description, /who received the task/)
assert.match(installed.get('super_session_request').description, /what the user will see next/)
assert.match(installed.get('super_session_request').description, /maximum 500 characters/i)
assert.match(installed.get('super_session_approval').description, /never approves or denies/)
assert.match(promptText, /anti-misdelivery constraint/)
assert.match(promptText, /does not add any prefix/)
assert.match(promptText, /\[Worker idle\]/)
assert.match(promptText, /super_session_approval/)
assert.match(promptText, /super_session_grant/)
assert.match(installed.get('super_session_grant').description, /explicitly asks/)
assert.match(promptText, /host-generated assistant welcome/)
assert.match(promptText, /scope="recent"/)
assert.match(promptText, /up to 5 workers/)
assert.match(promptText, /last 7 days/)
assert.match(promptText, /ask the user which session/)
assert.match(promptText, /Creating or updating a task does not count/)

const state = JSON.parse(readFileSync(join(stateDir, 'super.json'), 'utf8'))
assert.equal(state.superSessionId, superId)
assert.equal(state.tasks[0].goal, 'fix tests')
assert.equal(state.deliveries.length, 0)
assert.equal(state.grants.length, 0)
assert.equal(typeof state.recentWorkers['session-worker'].lastUsedAt, 'number')
assert.equal(state.recentWorkers['session-worker'].lastTaskId, task.task.taskId)
assert.equal('session-worker-2' in state.recentWorkers, false)

const beforeFailedUse = (await call('super_session_status', { scope: 'recent' })).workers[0].lastUsedAt
failPrompts.add('session-worker')
concluded = 0
const failedRequest = await call('super_session_request', { targetSessionIds: ['session-worker'], message: 'do not deliver' })
assert.equal(failedRequest.results[0].ok, false)
assert.equal('taskId' in failedRequest.results[0], false)
assert.match(failedRequest.results[0].error, /prompt failed/)
assert.equal(concluded, 0)
assertLossless(failedRequest)
const afterFailedUse = await call('super_session_status', { scope: 'recent' })
assert.equal(afterFailedUse.workers[0].lastUsedAt, beforeFailedUse)
assertLossless(afterFailedUse)
failPrompts.delete('session-worker')

for (const dispose of effects) dispose()
rmSync(stateDir, { recursive: true, force: true })
console.log('smoke ok')
