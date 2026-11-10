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

const worker = {
  id: 'session-worker',
  ctx: { tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} } },
  session: { snapshotEvents: () => [{ type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'worker says done' }] } } }] },
}
const superAgent = {
  id: superId,
  ctx: {
    tools: { register(definition) { installed.set(definition.name, definition); return () => {} } },
    systemPrompt: { section(section) { installed.set('prompt:' + section.name, section); return () => {} } },
  },
  session: { snapshotEvents: () => [] },
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
  on(name, handler) { listeners.set(name, handler) },
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
  sessionController: {
    async create(request) {
      assert.equal(request.workspaceId, workspace.id)
      assert.equal(request.cwd, undefined)
      created = true
      superId = String(request.sessionId)
      superAgent.id = superId
      const listener = listeners.get('agent/created')
      if (listener) await listener({ agent: superAgent })
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
        { sessionId: 'session-worker', running: true, blank: false, updatedAt: 2 },
        { sessionId: 'session-child', running: false, blank: false, updatedAt: 3, cwd: '/tmp', parentSessionId: 'session-worker', origin: 'subagent' },
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

function request(method, path) {
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
  setImmediate(() => req.emit('end'))
  return done.then(body => ({ status: res.statusCode, body: JSON.parse(body) }))
}

const ensured = await request('POST', '/plugins/dsh-super-session/api/ensure')
assert.equal(ensured.status, 200)
assert.equal(ensured.body.sessionId, superId)
assert.equal(created, true)
assert.deepEqual(workspaceAttachments, [superId])
assert.ok(installed.has('super_session_task'))
assert.ok(installed.has('super_session_status'))
assert.ok(installed.has('super_session_request'))
assert.ok(installed.has('super_session_read'))
assert.ok(installed.has('super_session_memory'))
assert.ok(installed.has('super_session_approval'))
assert.ok(installed.has('prompt:super-session-manager'))

let concluded = 0
const call = async (name, args) => installed.get(name).execute(args, {
  signal: new AbortController().signal,
  concludeTurn() { concluded += 1 },
})
const task = await call('super_session_task', { goal: 'fix tests', acceptance: 'green', executor: 'session-worker' })
assert.equal(task.task.taskId.startsWith('task_'), true)
concluded = 0
const requestResult = await call('super_session_request', { targetSessionIds: ['session-worker'], message: 'please fix', taskId: task.task.taskId })
assert.equal(requestResult.results[0].ok, true)
assert.equal(concluded, 1)
assert.equal(prompts.at(-1).content[0].text, 'please fix')
assert.equal(prompts.at(-1).requestId.startsWith('req_'), true)
concluded = 0
const quickRequest = await call('super_session_request', { targetSessionIds: ['session-worker'], message: 'just checking' })
assert.equal(quickRequest.results[0].ok, true)
assert.equal('taskId' in quickRequest.results[0], false)
assert.equal(concluded, 1)
assertLossless(quickRequest)
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
assert.deepEqual(sessions.sessions.map(item => item.sessionId), [superId, 'session-worker'].filter(id => id !== superId))
assertLossless(sessions)
assert.equal('parentSessionId' in sessions.sessions[0], false)
assert.equal('cwd' in sessions.sessions[0], false)
const sessionStatus = await call('super_session_status', { scope: 'sessions', sessionId: 'session-worker' })
assert.equal(sessionStatus.session.sessionId, 'session-worker')
assertLossless(sessionStatus)
const read = await call('super_session_read', { sessionId: 'session-worker', limit: 10 })
assert.equal(read.messages[0].text, 'worker says done')
await call('super_session_memory', { action: 'remember', key: 'language', text: 'Chinese' })
const memory = await call('super_session_memory', { action: 'read' })
assert.match(memory.text, /language/)
const promptText = installed.get('prompt:super-session-manager').text()
assert.match(promptText, /Chinese/)
assert.match(promptText, /Super Session id/)
assert.match(promptText, /End the current turn immediately/)
assert.match(installed.get('super_session_status').description, /never waits/)
assert.match(installed.get('super_session_request').description, /ends the current turn/)
assert.match(installed.get('super_session_approval').description, /never approves or denies/)
assert.match(promptText, /super_session_approval/)

const state = JSON.parse(readFileSync(join(stateDir, 'super.json'), 'utf8'))
assert.equal(state.superSessionId, superId)
assert.equal(state.tasks[0].goal, 'fix tests')
assert.equal(state.deliveries.length, 0)

failPrompts.add('session-worker')
concluded = 0
const failedRequest = await call('super_session_request', { targetSessionIds: ['session-worker'], message: 'do not deliver' })
assert.equal(failedRequest.results[0].ok, false)
assert.equal('taskId' in failedRequest.results[0], false)
assert.match(failedRequest.results[0].error, /prompt failed/)
assert.equal(concluded, 0)
assertLossless(failedRequest)
failPrompts.delete('session-worker')

for (const dispose of effects) dispose()
rmSync(stateDir, { recursive: true, force: true })
console.log('smoke ok')
