// dsh-super-session host half.
//
// A globally unique Super Session: an ordinary top-level DSH Session running the
// PTC preset, with a manager prompt and seven super_session_* tools installed on
// its Agent. It relays ordinary user messages to worker sessions and keeps its
// own task/delivery state in DSH_HOME/state/super-session/super.json.

import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ApprovalObserver } from './approvals.mjs'
import { DispatchGuard } from './dispatch-guard.mjs'
import { APPROVAL_POLICIES, GrantService, SANDBOX_MODES, publicGrant } from './grants.mjs'
import { HOST_REQUEST_PREFIX } from './wechat/request-ids.mjs'
import { WechatService } from './wechat/service.mjs'
import { WorkerIdleWatcher } from './worker-idle.mjs'

export const name = 'dsh-super-session'
export const inject = ['webServer', 'sessionController', 'workspaceRegistry', 'sandboxPolicy', 'approval', 'agents']

const SUPER_PRESET = 'ptc'
const API_PREFIX = '/plugins/dsh-super-session/api'
const MEMORY_LIMIT = 4096
const TASK_STATUSES = ['open', 'working', 'blocked', 'done', 'cancelled']
const MAX_RECOVERY_ATTEMPTS = 3
const DISPATCH_NOTE_LIMIT = 500
const RECENT_WORKER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const RECENT_WORKER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const RECENT_WORKER_LIMIT = 5

function recoveryLimitReason() {
  return '自动恢复已达上限（' + MAX_RECOVERY_ATTEMPTS + '/' + MAX_RECOVERY_ATTEMPTS + '），需要用户手动处理'
}
const WELCOME_TEXT = [
  '欢迎使用 Super Session。',
  '',
  '我是你的会话管家：你把目标告诉我，我负责澄清需求、把任务转给合适的 worker session，并跟踪结果。',
  '',
  '开始前请先：',
  '1. 在下方选择模型，Super 需要模型才能工作。',
  '2. 打开权限设置，建议选择最高权限（danger-full-access），并明确审批策略；否则敏感操作可能被拦截。',
  '3. 直接告诉我你想做什么，例如“帮我把这个需求交给那个会话”。',
  '',
  '第一次使用可以先说目标，我会先问清关键细节再下发。',
].join('\n')

const dshHome = () => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const now = () => Date.now()
const newId = prefix => prefix + now().toString(36) + '_' + randomUUID().replace(/-/g, '').slice(0, 10)
const asString = value => typeof value === 'string' ? value.trim() : ''

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return ''
    throw error
  }
}

function writeAtomic(file, text) {
  ensureDir(dirname(file))
  const temp = file + '.' + process.pid + '.' + randomUUID().slice(0, 8) + '.tmp'
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (!part || typeof part !== 'object') return ''
    if (part.type === 'text') return typeof part.text === 'string' ? part.text : ''
    if (part.type === 'image') return '[image]'
    if (part.type === 'file') return '[file' + (part.name ? ' ' + part.name : '') + ']'
    if (part.type === 'tool-call') return '[tool ' + (part.name || 'call') + ']'
    return ''
  }).filter(Boolean).join('\n')
}

function recordMessage(record) {
  if (!record || typeof record !== 'object') return undefined
  const data = record.data && typeof record.data === 'object' ? record.data : record
  let role = 'event'
  let content
  if (record.type === 'user/message') {
    role = 'user'
    content = data.content
  } else if (record.type === 'assistant/message') {
    role = 'assistant'
    content = data.message && data.message.content ? data.message.content : data.content
  } else if (record.type === 'tool/result') {
    role = 'tool'
    content = data.content
  } else {
    return undefined
  }
  const text = textOfContent(content).trim()
  if (!text) return undefined
  return {
    seq: typeof record.seq === 'number' ? record.seq : undefined,
    at: typeof record.at === 'number' ? record.at : (typeof record.time === 'number' ? record.time : undefined),
    role,
    text,
  }
}

function taskSummary(task) {
  return {
    taskId: task.taskId,
    goal: task.goal,
    acceptance: task.acceptance,
    executor: task.executor,
    status: task.status,
    blockedReason: task.blockedReason || '',
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    recoveryCount: typeof task.recoveryCount === 'number' ? task.recoveryCount : 0,
  }
}

function sessionTitle(summary) {
  const title = summary && summary.projections && summary.projections.values
    ? summary.projections.values.title
    : undefined
  return typeof title === 'string' ? title.trim() : ''
}

class SuperStore {
  constructor(stateDir) {
    this.stateDir = stateDir
    this.file = join(stateDir, 'super.json')
    this.data = {
      version: 1,
      superSessionId: undefined,
      superPreset: undefined,
      createdAt: undefined,
      tasks: [],
      deliveries: [],
      grants: [],
      recentWorkers: {},
      settings: { dispatchGuard: true },
    }
    this.load()
  }

  load() {
    ensureDir(this.stateDir)
    const raw = readText(this.file)
    if (!raw.trim()) return
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        this.data.version = 1
        this.data.superSessionId = typeof parsed.superSessionId === 'string' ? parsed.superSessionId : undefined
        this.data.superPreset = typeof parsed.superPreset === 'string' ? parsed.superPreset : undefined
        this.data.createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : undefined
        this.data.tasks = Array.isArray(parsed.tasks) ? parsed.tasks.filter(item => item && typeof item.taskId === 'string') : []
        this.data.deliveries = Array.isArray(parsed.deliveries) ? parsed.deliveries.filter(item => item && typeof item.deliveryId === 'string') : []
        this.data.grants = Array.isArray(parsed.grants) ? parsed.grants.filter(item => item && typeof item.grantId === 'string') : []
        const recent = parsed.recentWorkers && typeof parsed.recentWorkers === 'object' ? parsed.recentWorkers : {}
        for (const [id, value] of Object.entries(recent)) {
          if (!id || !value || typeof value !== 'object') continue
          const lastUsedAt = typeof value.lastUsedAt === 'number' && Number.isFinite(value.lastUsedAt) ? value.lastUsedAt : 0
          if (lastUsedAt <= 0) continue
          const record = { lastUsedAt }
          if (typeof value.lastTaskId === 'string' && value.lastTaskId) record.lastTaskId = value.lastTaskId
          this.data.recentWorkers[id] = record
        }
        const settings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}
        this.data.settings.dispatchGuard = typeof settings.dispatchGuard === 'boolean' ? settings.dispatchGuard : true
      }
    } catch {
      // A corrupt state file must not stop DSH from starting. Keep the file for inspection.
    }
  }

  save() {
    writeAtomic(this.file, JSON.stringify(this.data, null, 2) + '\n')
  }

  get superSessionId() { return this.data.superSessionId }
  get superPreset() { return this.data.superPreset }

  settings() { return { dispatchGuard: this.data.settings.dispatchGuard } }

  setDispatchGuard(enabled) {
    this.data.settings.dispatchGuard = Boolean(enabled)
    this.save()
    return this.settings()
  }

  setSuper(sessionId, preset) {
    this.data.superSessionId = sessionId
    this.data.superPreset = preset
    this.data.createdAt = this.data.createdAt || now()
    this.save()
  }

  recentWorkers() { return this.data.recentWorkers }
  recentWorker(sessionId) { return this.data.recentWorkers[String(sessionId)] }

  touchWorker(sessionId, taskId) {
    const id = String(sessionId)
    if (!id) return undefined
    const record = this.data.recentWorkers[id] || { lastUsedAt: 0 }
    record.lastUsedAt = now()
    if (taskId) record.lastTaskId = String(taskId)
    this.data.recentWorkers[id] = record
    const cutoff = record.lastUsedAt - RECENT_WORKER_RETENTION_MS
    for (const [key, value] of Object.entries(this.data.recentWorkers)) {
      if (!value || typeof value.lastUsedAt !== 'number' || value.lastUsedAt < cutoff) delete this.data.recentWorkers[key]
    }
    this.save()
    return record
  }

  tasks() { return this.data.tasks }
  activeTasks() { return this.data.tasks.filter(task => task.status === 'open' || task.status === 'working') }
  task(taskId) { return this.data.tasks.find(task => task.taskId === taskId) }

  addTask(input) {
    const task = {
      taskId: newId('task_'),
      goal: input.goal,
      acceptance: input.acceptance || '',
      executor: input.executor,
      status: input.status || 'open',
      blockedReason: input.blockedReason || '',
      createdAt: now(),
      updatedAt: now(),
      recoveryCount: 0,
    }
    this.data.tasks.push(task)
    this.save()
    return task
  }

  updateTask(taskId, patch) {
    const task = this.task(taskId)
    if (!task) return undefined
    if (patch.goal !== undefined) task.goal = patch.goal
    if (patch.acceptance !== undefined) task.acceptance = patch.acceptance
    if (patch.executor !== undefined) task.executor = patch.executor
    if (patch.status !== undefined) {
      task.status = patch.status
      if (patch.status !== 'blocked' && patch.blockedReason === undefined) task.blockedReason = ''
    }
    if (patch.blockedReason !== undefined) task.blockedReason = patch.blockedReason
    if (patch.recoveryCount !== undefined) task.recoveryCount = patch.recoveryCount
    task.updatedAt = now()
    this.save()
    return task
  }

  deliveries() { return this.data.deliveries }
  delivery(deliveryId) { return this.data.deliveries.find(item => item.deliveryId === deliveryId) }

  addDelivery(input) {
    const delivery = {
      deliveryId: newId('del_'),
      targetSessionId: input.targetSessionId,
      requestId: input.requestId,
      taskId: input.taskId || undefined,
      content: input.content,
      mode: input.mode || 'queue',
      createdAt: now(),
    }
    this.data.deliveries.push(delivery)
    this.save()
    return delivery
  }

  removeDelivery(deliveryId) {
    this.data.deliveries = this.data.deliveries.filter(item => item.deliveryId !== deliveryId)
    this.save()
  }

  grants() { return this.data.grants }
  grant(grantId) { return this.data.grants.find(item => item.grantId === grantId) }

  addGrant(grant) {
    this.data.grants.push(grant)
    this.save()
    return grant
  }

  updateGrant(grantId, patch) {
    const grant = this.grant(grantId)
    if (!grant) return undefined
    Object.assign(grant, patch)
    this.save()
    return grant
  }

  removeGrant(grantId) {
    this.data.grants = this.data.grants.filter(item => item.grantId !== grantId)
    this.save()
  }

  memoryFile() { return join(this.stateDir, 'memory.md') }
  readMemory() { return readText(this.memoryFile()) }
  writeMemory(text) {
    if (Buffer.byteLength(text, 'utf8') > MEMORY_LIMIT) throw new Error('memory.md would exceed ' + MEMORY_LIMIT + ' bytes; merge or remove entries first')
    writeAtomic(this.memoryFile(), text)
  }
}

function managerPrompt(sessionId, memory) {
  const lines = [
    'You are the Super Session for this DSH installation. There is exactly one Super Session, and you are it.',
    'You do not replace workers. You clarify requirements with the user, turn agreed work into tasks, hand tasks to ordinary top-level worker sessions, monitor on demand, and report back.',
    'You may do concrete work yourself only when the user explicitly asks you to; otherwise delegate.',
    '',
    '## How you work',
    '- A new Super Session begins with a host-generated assistant welcome that asks the user to choose a model and permissions. Treat it as already said; do not repeat it.',
    '- A user request is ordinary conversation. If goal, scope, or acceptance is unclear, ask only the blocking questions first. Do not dispatch a vague task. If the user says to decide, record your assumptions and continue.',
    '- When a task is clear, restate the goal and acceptance once, then create a task. One task has exactly one executor: self, or one top-level worker session id.',
    '- When the user asks for a task but does not name a worker, choose only from recently used top-level workers. Call super_session_status with scope="recent": it returns up to 5 workers that the Super Session has used in the last 7 days, newest first, with sessionId, title, cwd, lastUsedAt, lastTaskGoal, and lastTaskStatus. Pick the one whose workspace, capability, and recent context best fit the task, and dispatch to it directly. Do not list or scan all sessions, and never pick a worker that has not been used recently.',
    '- If scope="recent" returns no workers, or none of them clearly fits, or you are still unsure after reading those fields, ask the user which session to use. Do not guess, and do not fall back to an arbitrary or new session.',
    '- A worker counts as recently used only after a successful super_session_request to it. Creating or updating a task does not count. When the user names a worker session id, use that session if it is top-level; verify it with scope="sessions" when needed. Do not pick subagent sessions or the Super Session itself.',
    '- Use super_session_request with taskId to dispatch a task. The host provides a neutral anti-misdelivery constraint through the worker\'s system prompt; it does not add any prefix to the message. Do not add that note yourself. A request without taskId is a raw quick relay; use it only for literal relay or short messages, not for task dispatch.',
    '- If a task is already running and the requirement changes, ask the user whether to queue or steer before using steer mode.',
    '- Every super_session_request that dispatches a task (taskId) MUST include note: one or two sentences for the user that say who received the task, what they were asked to do, and what the user will see next. The host displays note in the Super Session transcript, so it is the user-visible reply; do not rely on assistant text instead, and never send a task dispatch without note. A quick relay without taskId does not need note. A successful request means the message was accepted and the work now belongs to the worker. End the current turn immediately after it: do not sleep, do not poll, and do not call super_session_status or super_session_read again in this turn. Do not write a wait loop inside run_code.',
    '- A host message beginning with [Worker idle] only means that worker turn ended; it does not mean the task is done. Read the worker before deciding. If it finished, close the task and report. If it is waiting for user input or approval, mark the task blocked with blockedReason and report; do not answer for the user. If it needs more work, send a continuation.',
    '- super_session_status is a one-shot snapshot and never waits. Use it only on demand, in a later turn. When the user asks you to keep watching something, use the official schedule tools with target this_session; do not invent a timer.',
    '- Use super_session_approval to list worker approval requests that are waiting. This tool only observes; it cannot approve or deny. Tell the user which worker, which tool, and the reason, and that they must open that worker session to allow or deny. Do not claim an approval was granted. After the user decides there, use super_session_request with mode=steer only if the task needs a changed instruction.',
    '- Use super_session_grant only when the user explicitly asks to change a worker\'s sandbox mode or approval policy. Never enable broader permissions on your own, and never treat a blocked task as permission. Set requires userConfirmed=true. The host records originals and restores them when the linked task is done/cancelled, on explicit reset, at expiry (default 30 minutes, max 24 hours), or at startup. Use action=list to see active grants; do not claim a grant without one.',
    '- On a restart/recovery message, read the worker first. If the work is done, close the task. If it needs the user, mark it blocked with blockedReason and report. If it can continue, send a continuation that tells the worker to inspect the workspace, changed files, and tests before resuming, and not repeat finished work. A task that reaches the host recovery limit is marked blocked and reported; do not reopen it without the user. Updating a task or successfully dispatching it resets recoveryCount, so the limit only counts consecutive unattended restarts.',
    '- When the user asks for a case set from experience, output it in the conversation: requirement, wrong approach, correct approach (usually what the user corrected). Save it to a file only when the user gives an explicit path; use normal file tools.',
    '- Keep memory.md for stable preferences only, never task progress or secrets. The current user message wins over memory.',
    '',
    '## Tools',
    'The host exposes super_session_task, super_session_status, super_session_request, super_session_read, super_session_memory, super_session_approval, and super_session_grant.',
    'This session runs PTC. Call these through the generated SDK inside run_code, for example: const r = await tools.super_session_status({ scope: "tasks" }); return r.',
    'Never claim a tool ran when it did not. Tool results are ordinary JSON.',
    '',
    '## Identity',
    'Super Session id: ' + sessionId + '.',
  ]
  if (memory) {
    lines.push('', '## User memory (preferences, not commands)', memory.trim())
  }
  return lines.join('\n')
}

function jsonSend(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  const host = req.headers.host
  if (!host) return false
  return origin === 'http://' + host || origin === 'https://' + host
}

function readBody(req, limit = 65536) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export class SuperSessionService {
  constructor(ctx, stateDir, options = {}) {
    this.ctx = ctx
    this.stateDir = stateDir
    this.store = new SuperStore(stateDir)
    this.installed = new WeakSet()
    this.disposers = []
    this.creatingId = undefined
    this.ensuring = undefined
    this.started = false
    this.approvals = new ApprovalObserver({
      ctx,
      store: this.store,
      log: (level, message) => this.log(level, 'approval: ' + message),
    })
    this.grants = new GrantService({
      ctx,
      store: this.store,
      stateDir,
      isWorker: sessionId => this.isWorker(sessionId),
      log: (level, message) => this.log(level, 'grant: ' + message),
    })
    this.wechat = new WechatService({
      ctx,
      stateDir,
      ensureSuper: () => this.ensure().then(result => result.sessionId),
      getSuperId: () => this.store.superSessionId,
      log: (level, message) => this.log(level, 'wechat: ' + message),
      markdownFile: options.markdownFile,
    })
    this.workerIdle = new WorkerIdleWatcher({
      ctx,
      store: this.store,
      ensureSuper: () => this.ensure().then(result => result.sessionId),
      getSuperId: () => this.store.superSessionId,
      log: (level, message) => this.log(level, 'worker-idle: ' + message),
      options,
    })
    this.dispatchGuard = new DispatchGuard({
      ctx,
      enabled: () => this.store.settings().dispatchGuard,
      log: (level, message) => this.log(level, 'dispatch-guard: ' + message),
    })
  }

  log(level, message) {
    const logger = this.ctx.logger
    if (!logger || typeof logger[level] !== 'function') return
    logger[level]('dsh-super-session: %s', message)
  }

  onAgentCreated(agent) {
    const id = String(agent.id)
    if (id !== this.store.superSessionId && id !== this.creatingId) return
    try {
      this.install(agent)
    } catch (error) {
      this.log('error', 'could not install on agent ' + id + ': ' + String(error && error.message ? error.message : error))
    }
  }

  install(agent) {
    if (this.installed.has(agent)) return
    this.installed.add(agent)
    const sessionId = String(agent.id)
    const register = (toolName, description, parameters, execute) => {
      const dispose = agent.ctx.tools.register({
        name: toolName,
        description,
        parameters,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: (args, exec) => execute(args && typeof args === 'object' ? args : {}, exec),
      })
      if (typeof dispose === 'function') this.disposers.push(dispose)
    }

    register(
      'super_session_task',
      'Create, update, or close one Super task. A task has exactly one executor: self or a top-level worker session id. Use status=done/cancelled to close. Updating any field resets recoveryCount to 0; use status=blocked with blockedReason for a task that needs the user.',
      {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Existing task to update. Omit to create a new task.' },
          goal: { type: 'string', description: 'What must be achieved, in the user words.' },
          acceptance: { type: 'string', description: 'How completion is judged.' },
          executor: { type: 'string', description: 'self, or the sessionId of one top-level worker.' },
          status: { type: 'string', enum: TASK_STATUSES },
          blockedReason: { type: 'string', description: 'Why the task is blocked; visible to the user and in status.' },
        },
        additionalProperties: false,
      },
      async args => this.toolTask(args),
    )

    register(
      'super_session_status',
      'Read a one-shot snapshot of task state, or list top-level worker sessions. scope=tasks returns tasks; scope=sessions lists all top-level workers with title, cwd, updatedAt and lastUsedAt; scope=recent lists up to 5 workers the Super Session used successfully in the last 7 days, newest first, with sessionId, title, cwd, lastUsedAt, lastTaskGoal and lastTaskStatus. Optionally read one session state. This call never waits for a worker and never resumes a cold session.',
      {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['tasks', 'sessions', 'recent'] },
          sessionId: { type: 'string', description: 'With scope=sessions, read only this session state.' },
        },
        additionalProperties: false,
      },
      async (args, exec) => this.toolStatus(args, exec.signal),
    )

    register(
      'super_session_request',
      'Send a message to one or more top-level worker sessions. A successful request records each target as recently used by the Super Session. With taskId, note is REQUIRED: one or two user-facing sentences saying who received the task, what they were asked to do, and what the user will see next. The host writes note to the Super Session transcript as a visible command card without adding it to model context, so note is the user-visible reply; do not rely on assistant text instead. A missing, blank, or over-500-character note is an error (maximum 500 characters) and nothing is delivered. With taskId the host relies on the worker\'s system prompt for the anti-misdelivery constraint and adds no message prefix. Without taskId the message is relayed raw and note is optional. The call returns when the message is accepted, not when work finishes. If every target succeeds, it ends the current turn: do not sleep, poll, or call status/read afterward. Use mode=steer only when the user explicitly wants to interrupt.',
      {
        type: 'object',
        properties: {
          targetSessionIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 },
          message: { type: 'string', description: 'Convenience text content. Ignored when content is provided.' },
          content: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'DSH prompt content parts: text, image (mediaType/data/name), or file (receiptId).' },
          taskId: { type: 'string', description: 'Optional task to associate. Its executor must equal each target. When set, note is required.' },
          note: { type: 'string', description: 'Required with taskId. One or two user-facing sentences shown to the user in the Super Session transcript: who received the task, what they were asked to do, and what happens next. Maximum 500 characters; longer notes are rejected, not truncated.' },
          mode: { type: 'string', enum: ['queue', 'steer'] },
        },
        required: ['targetSessionIds'],
        additionalProperties: false,
      },
      async (args, exec) => this.toolRequest(args, exec),
    )

    register(
      'super_session_read',
      'Read the most recent messages of one session without resuming it. Returns user and assistant text, with image/file placeholders.',
      {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          limit: { type: 'number', minimum: 1, maximum: 100 },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      async (args, exec) => this.toolRead(args, exec.signal),
    )

    register(
      'super_session_approval',
      'List worker approval requests currently waiting, limited to workers with an active task. Read-only: this tool never approves or denies and never answers for the UI.',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list'], description: 'Phase 1 supports list only.' },
        },
        additionalProperties: false,
      },
      async args => this.toolApproval(args),
    )

    register(
      'super_session_grant',
      'Temporarily change one worker session\'s sandbox mode or approval policy. Call only after the user explicitly asks; never enable permissions on your own. The host records the original effective values, writes audit.jsonl, restores at task done/cancelled, explicit reset, expiry, or next startup, and requires userConfirmed=true. This does not change worker tools.',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set', 'list', 'reset'] },
          sessionId: { type: 'string', description: 'Top-level worker session to modify. Required for set.' },
          taskId: { type: 'string', description: 'Optional task whose completion should restore the grant automatically.' },
          sandboxMode: { type: 'string', enum: SANDBOX_MODES },
          approvalPolicy: { type: 'string', enum: APPROVAL_POLICIES },
          ttlSeconds: { type: 'number', minimum: 60, maximum: 86400 },
          reason: { type: 'string' },
          grantId: { type: 'string', description: 'Required for reset.' },
          userConfirmed: { type: 'boolean', description: 'Must be true; set only after an explicit user instruction.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async args => this.toolGrant(args),
    )

    register(
      'super_session_memory',
      'Read or edit the global memory.md. Use only for stable user preferences, never task progress or secrets.',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'remember', 'forget'] },
          text: { type: 'string' },
          key: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async args => this.toolMemory(args),
    )

    const disposePrompt = agent.ctx.systemPrompt.section({
      name: 'super-session-manager',
      order: 40,
      interpolate: false,
      text: () => managerPrompt(sessionId, this.store.readMemory()),
    })
    if (typeof disposePrompt === 'function') this.disposers.push(disposePrompt)
    this.log('info', 'installed manager prompt and 7 tools on ' + sessionId)
  }

  async toolTask(args) {
    if (args.taskId) {
      const existing = this.store.task(args.taskId)
      if (!existing) throw new Error('task not found: ' + args.taskId)
      const patch = { recoveryCount: 0 }
      if (args.goal !== undefined) {
        const goal = asString(args.goal)
        if (!goal) throw new Error('goal must not be empty')
        patch.goal = goal
      }
      if (args.acceptance !== undefined) patch.acceptance = String(args.acceptance)
      if (args.executor !== undefined) {
        const executor = asString(args.executor)
        if (!executor) throw new Error('executor must not be empty')
        patch.executor = executor
      }
      if (args.status !== undefined) {
        if (!TASK_STATUSES.includes(args.status)) throw new Error('invalid task status: ' + args.status)
        patch.status = args.status
      }
      if (args.blockedReason !== undefined) patch.blockedReason = String(args.blockedReason)
      const task = this.store.updateTask(args.taskId, patch)
      if (task && (task.status === 'done' || task.status === 'cancelled')) await this.grants.onTaskChanged(task)
      return { task: taskSummary(task) }
    }
    const goal = asString(args.goal)
    const executor = asString(args.executor)
    if (!goal) throw new Error('goal is required when creating a task')
    if (!executor) throw new Error('executor is required when creating a task')
    if (args.status !== undefined && !TASK_STATUSES.includes(args.status)) throw new Error('invalid task status: ' + args.status)
    const task = this.store.addTask({ goal, acceptance: args.acceptance ? String(args.acceptance) : '', executor, status: args.status || 'open', blockedReason: args.blockedReason ? String(args.blockedReason) : '' })
    if (task.status === 'done' || task.status === 'cancelled') await this.grants.onTaskChanged(task)
    return { task: taskSummary(task) }
  }

  async listSessions(signal) {
    const page = await this.ctx.sessionController.list({}, signal)
    return Array.isArray(page && page.items) ? page.items : []
  }

  async isWorker(sessionId) {
    const id = String(sessionId)
    if (id === this.store.superSessionId) return false
    const items = await this.listSessions()
    const summary = items.find(item => String(item.sessionId) === id)
    if (!summary) return false
    if (summary.parentSessionId || summary.origin === 'subagent') return false
    return true
  }

  async toolStatus(args, signal) {
    const scope = args.scope === 'recent' && !args.sessionId
      ? 'recent'
      : (args.scope === 'sessions' || args.sessionId ? 'sessions' : 'tasks')
    if (scope === 'tasks') {
      return {
        scope,
        superSessionId: this.store.superSessionId || null,
        tasks: this.store.tasks().map(taskSummary),
        pendingDeliveries: this.store.deliveries().length,
      }
    }
    const items = await this.listSessions(signal)
    const superId = this.store.superSessionId
    const sessions = items.filter(summary => {
      const id = String(summary.sessionId)
      if (superId && id === superId) return false
      if (summary.parentSessionId) return false
      if (summary.origin === 'subagent') return false
      return true
    }).map(summary => {
      const item = {
        sessionId: String(summary.sessionId),
        running: Boolean(summary.running),
        blank: Boolean(summary.blank),
      }
      const title = sessionTitle(summary)
      if (title) item.title = title
      if (summary.updatedAt !== undefined) item.updatedAt = summary.updatedAt
      if (summary.cwd !== undefined) item.cwd = String(summary.cwd)
      const used = this.store.recentWorker(item.sessionId)
      if (used && used.lastUsedAt) item.lastUsedAt = used.lastUsedAt
      if (summary.parentSessionId !== undefined) item.parentSessionId = String(summary.parentSessionId)
      return item
    })
    if (scope === 'recent') {
      const cutoff = now() - RECENT_WORKER_WINDOW_MS
      const byId = new Map(sessions.map(item => [item.sessionId, item]))
      const records = Object.entries(this.store.recentWorkers())
        .filter(([sessionId, record]) => record && record.lastUsedAt >= cutoff && byId.has(sessionId))
        .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
        .slice(0, RECENT_WORKER_LIMIT)
      const workers = records.map(([sessionId, record]) => {
        const item = { ...byId.get(sessionId), lastUsedAt: record.lastUsedAt }
        if (record.lastTaskId) {
          item.lastTaskId = record.lastTaskId
          const task = this.store.task(record.lastTaskId)
          if (task) {
            item.lastTaskGoal = task.goal
            item.lastTaskStatus = task.status
          }
        }
        return item
      })
      return {
        scope,
        windowDays: RECENT_WORKER_WINDOW_MS / 86400000,
        limit: RECENT_WORKER_LIMIT,
        workers,
        pendingDeliveries: this.store.deliveries().length,
      }
    }
    if (args.sessionId) {
      const sessionId = asString(args.sessionId)
      const found = sessions.find(item => item.sessionId === sessionId)
      if (!found) throw new Error('session is not an available top-level session: ' + sessionId)
      let state
      try {
        state = await this.ctx.sessionController.state({ sessionId }, signal)
      } catch (error) {
        state = { error: String(error && error.message ? error.message : error) }
      }
      return { scope, session: found, state, pendingDeliveries: this.store.deliveries().length }
    }
    return { scope, sessions, pendingDeliveries: this.store.deliveries().length }
  }

  contentOf(args) {
    if (Array.isArray(args.content) && args.content.length) {
      return args.content.map(part => {
        if (!part || typeof part !== 'object') throw new Error('content parts must be objects')
        if (part.type === 'text') {
          if (typeof part.text !== 'string' || !part.text) throw new Error('text content requires text')
          return { type: 'text', text: part.text }
        }
        if (part.type === 'image') {
          if (typeof part.mediaType !== 'string' || typeof part.data !== 'string') throw new Error('image content requires mediaType and data')
          return { type: 'image', mediaType: part.mediaType, data: part.data, ...(part.name ? { name: String(part.name) } : {}) }
        }
        if (part.type === 'file') {
          if (typeof part.receiptId !== 'string' || !part.receiptId) throw new Error('file content requires receiptId')
          return { type: 'file', receiptId: part.receiptId }
        }
        throw new Error('unsupported content type: ' + String(part.type))
      })
    }
    const message = asString(args.message)
    if (!message) throw new Error('message or content is required')
    return [{ type: 'text', text: message }]
  }

  async toolRequest(args, exec) {
    const signal = exec.signal
    const targets = Array.isArray(args.targetSessionIds) ? args.targetSessionIds.map(asString).filter(Boolean) : []
    if (!targets.length) throw new Error('targetSessionIds must contain at least one session id')
    if (targets.length > 32) throw new Error('at most 32 targets per request')
    if (args.mode !== undefined && args.mode !== 'queue' && args.mode !== 'steer') throw new Error('invalid mode')
    const mode = args.mode || 'queue'
    const content = this.contentOf(args)
    const superId = this.store.superSessionId
    const taskId = args.taskId ? asString(args.taskId) : undefined
    const task = taskId ? this.store.task(taskId) : undefined
    if (taskId && !task) throw new Error('task not found: ' + taskId)
    if (task && (task.status === 'done' || task.status === 'cancelled')) throw new Error('task is closed: ' + taskId)
    const note = this.dispatchNote(args, taskId)

    const items = await this.listSessions(signal)
    const byId = new Map(items.map(summary => [String(summary.sessionId), summary]))
    const results = []
    for (const target of targets) {
      if (superId && target === superId) {
        results.push({ targetSessionId: target, ok: false, error: 'cannot send a worker message to the Super Session itself' })
        continue
      }
      const summary = byId.get(target)
      if (!summary) {
        results.push({ targetSessionId: target, ok: false, error: 'not a listed session' })
        continue
      }
      if (summary.parentSessionId || summary.origin === 'subagent') {
        results.push({ targetSessionId: target, ok: false, error: 'target is a subagent session' })
        continue
      }
      if (task && task.executor !== target) {
        results.push({ targetSessionId: target, ok: false, error: 'task executor is ' + task.executor + ', not this target' })
        continue
      }
      const requestId = newId('req_')
      const delivery = this.store.addDelivery({ targetSessionId: target, requestId, taskId, content, mode })
      try {
        await this.ctx.sessionController.prompt({ requestId, sessionId: target, mode, content }, signal)
        this.store.removeDelivery(delivery.deliveryId)
        try {
          this.store.touchWorker(target, taskId)
        } catch (error) {
          this.log('warn', 'could not record recent worker ' + target + ': ' + String(error && error.message ? error.message : error))
        }
        if (task) this.store.updateTask(task.taskId, { status: 'working', recoveryCount: 0 })
        results.push({ targetSessionId: target, ok: true, requestId, ...(taskId ? { taskId } : {}) })
      } catch (error) {
        results.push({ targetSessionId: target, ok: false, requestId, ...(taskId ? { taskId } : {}), error: String(error && error.message ? error.message : error) })
      }
    }
    if (results.every(item => item.ok)) {
      if (note) this.appendDispatchNote(exec.agent, note, taskId !== undefined)
      exec.concludeTurn()
    }
    return { results, pendingDeliveries: this.store.deliveries().length }
  }

  dispatchNote(args, taskId) {
    const text = typeof args.note === 'string' ? args.note.trim() : ''
    if (!text) {
      if (taskId) throw new Error('super_session_request requires a non-empty note when taskId is set: one or two sentences for the user saying who received the task, what they were asked to do, and what happens next')
      return undefined
    }
    const length = [...text].length
    if (length > DISPATCH_NOTE_LIMIT) throw new Error('super_session_request note is ' + length + ' characters; the maximum is ' + DISPATCH_NOTE_LIMIT + '. Shorten it; the note is not truncated.')
    return text
  }

  appendDispatchNote(agent, note, isTask) {
    const superId = this.store.superSessionId
    if (!agent || String(agent.id) !== String(superId)) {
      this.log('warn', 'could not display dispatch note: not on the Super Session')
      return false
    }
    const session = agent.session
    if (!session || typeof session.append !== 'function') {
      this.log('warn', 'could not display dispatch note: Super Session has no append')
      return false
    }
    const commandId = 'super-dispatch-' + randomUUID()
    try {
      session.append('command/run', { commandId, name: isTask ? '任务派发' : '消息转发', source: { kind: 'user' } })
      // The trailing newline makes the command card expandable in the DSH chat UI;
      // otherwise a long note would be ellipsized with no way to see the rest.
      session.append('command/done', { commandId, kind: 'success', text: note + '\n' })
      return true
    } catch (error) {
      this.log('warn', 'could not display dispatch note: ' + String(error && error.message ? error.message : error))
      return false
    }
  }

  async toolRead(args, signal) {
    const sessionId = asString(args.sessionId)
    if (!sessionId) throw new Error('sessionId is required')
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 30))
    let records = []
    let live = false
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if (!('error' in resolved)) {
      live = true
      const events = resolved.agent.session.snapshotEvents()
      records = Array.isArray(events) ? events : []
    } else if (resolved.error.code === 'session/not-found') {
      throw new Error('session not found: ' + sessionId)
    } else {
      const page = await this.ctx.sessionController.events({ address: { kind: 'session', sessionId }, maxMessages: limit }, signal)
      records = Array.isArray(page && page.records) ? page.records : []
    }
    const messages = records.map(recordMessage).filter(Boolean).slice(-limit)
    return { sessionId, live, messages }
  }

  async toolApproval(args) {
    const action = args.action === undefined ? 'list' : args.action
    if (action !== 'list') throw new Error('unknown approval action: ' + String(action))
    const pending = this.approvals.list()
    return { pending, count: pending.length }
  }

  async toolGrant(args) {
    const action = args.action === undefined ? 'list' : args.action
    if (action === 'set') {
      const grant = await this.grants.set(args)
      return { grant }
    }
    if (action === 'list') {
      await this.grants.reconcile()
      const grants = this.grants.list()
      return { grants, count: grants.length }
    }
    if (action === 'reset') {
      const grantId = asString(args.grantId)
      if (!grantId) throw new Error('grantId is required for reset')
      const result = await this.grants.restore(grantId, 'explicit-reset')
      if (result.missing) throw new Error('grant not found: ' + grantId)
      if (result.busy) throw new Error('grant is already being restored: ' + grantId)
      if (result.error) throw new Error(result.error)
      return result
    }
    throw new Error('unknown grant action: ' + String(action))
  }

  async toolMemory(args) {
    const action = args.action
    if (action === 'read') {
      const text = this.store.readMemory()
      return { text, bytes: Buffer.byteLength(text, 'utf8'), limit: MEMORY_LIMIT }
    }
    if (action === 'remember') {
      const text = asString(args.text)
      if (!text) throw new Error('text is required for remember')
      const key = asString(args.key)
      const line = key ? '- **' + key + '**: ' + text : '- ' + text
      let current = this.store.readMemory()
      if (current && !current.endsWith('\n')) current += '\n'
      this.store.writeMemory(current + line + '\n')
      const next = this.store.readMemory()
      return { ok: true, bytes: Buffer.byteLength(next, 'utf8'), limit: MEMORY_LIMIT }
    }
    if (action === 'forget') {
      const key = asString(args.key)
      const text = asString(args.text)
      if (!key && !text) throw new Error('key or text is required for forget')
      const current = this.store.readMemory()
      const lines = current.split('\n')
      const kept = lines.filter(line => {
        if (key && line.toLowerCase().includes(key.toLowerCase())) return false
        if (text && line.includes(text)) return false
        return true
      })
      const removed = lines.length - kept.length
      this.store.writeMemory(kept.join('\n'))
      return { ok: true, removed, bytes: Buffer.byteLength(this.store.readMemory(), 'utf8'), limit: MEMORY_LIMIT }
    }
    throw new Error('unknown memory action: ' + String(action))
  }

  async resolve(id) {
    return this.ctx.sessionController.resolveAgent(id)
  }

  async ensure() {
    if (this.ensuring) return this.ensuring
    this.ensuring = this.doEnsure().finally(() => { this.ensuring = undefined })
    return this.ensuring
  }

  async ensureWorkspace() {
    const registry = this.ctx.workspaceRegistry
    if (!registry || typeof registry.create !== 'function') {
      throw new Error('the Workspace registry is unavailable, so the Super Session cannot be opened as a normal session')
    }
    return await registry.create(this.stateDir, 'Super Session')
  }

  appendWelcome(agent) {
    const session = agent && agent.session
    if (!session || typeof session.append !== 'function') {
      this.log('warn', 'cannot show the welcome message: the Super Session is not appendable')
      return
    }
    const turn = 0
    const step = 0
    let opened = false
    try {
      session.append('turn/start', { turn })
      opened = true
      session.append('step/start', { turn, step })
      session.append('assistant/message', {
        turn,
        step,
        message: {
          id: randomUUID(),
          role: 'assistant',
          source: { kind: 'model', provider: 'dsh', model: 'super-session-welcome' },
          content: [{ type: 'text', text: WELCOME_TEXT }],
        },
        stream: [],
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      opened = false
    } catch (error) {
      if (opened) {
        try { session.append('step/end', { turn, step }) } catch {}
        try {
          session.append('turn/end', {
            turn,
            reason: { kind: 'error', error: { code: 'WELCOME_FAILED', message: String(error && error.message ? error.message : error) } },
          })
        } catch {}
      }
      throw error
    }
  }

  async doEnsure() {
    const stored = this.store.superSessionId
    if (stored) {
      const resolved = await this.resolve(stored)
      if (!('error' in resolved)) {
        const workspace = await this.ensureWorkspace()
        await workspace.attachSession(stored)
        this.install(resolved.agent)
        return { sessionId: stored, created: false, preset: this.store.superPreset || null }
      }
      if (resolved.error.code !== 'session/not-found') {
        throw new Error('cannot open Super Session ' + stored + ': ' + resolved.error.message)
      }
    }
    const workspace = await this.ensureWorkspace()
    const wanted = stored || ('session-' + randomUUID())
    this.creatingId = wanted
    try {
      const created = await this.ctx.sessionController.create({ sessionId: wanted, workspaceId: workspace.id, agentPreset: SUPER_PRESET })
      if (created.agentPreset !== SUPER_PRESET) {
        throw new Error('Super Session requires the PTC preset, but DSH created it with ' + String(created.agentPreset) + '. Enable the ptc preset/runtime and retry.')
      }
      const sessionId = String(created.sessionId)
      this.store.setSuper(sessionId, created.agentPreset)
      const resolved = await this.resolve(sessionId)
      if ('error' in resolved) throw new Error('Super Session was created but its agent is unavailable: ' + resolved.error.message)
      this.install(resolved.agent)
      try {
        this.appendWelcome(resolved.agent)
      } catch (error) {
        this.log('warn', 'could not append the welcome message: ' + String(error && error.message ? error.message : error))
      }
      try {
        await this.ctx.sessionController.rename({ sessionId, title: 'Super Session' })
      } catch (error) {
        this.log('warn', 'could not rename Super Session: ' + String(error && error.message ? error.message : error))
      }
      return { sessionId, created: true, preset: created.agentPreset }
    } finally {
      this.creatingId = undefined
    }
  }

  async retryDeliveries(signal) {
    const pending = this.store.deliveries().slice()
    for (const delivery of pending) {
      try {
        await this.ctx.sessionController.prompt({
          requestId: delivery.requestId,
          sessionId: delivery.targetSessionId,
          mode: delivery.mode || 'queue',
          content: delivery.content,
        }, signal)
        this.store.removeDelivery(delivery.deliveryId)
        if (delivery.taskId) {
          const task = this.store.task(delivery.taskId)
          if (task && (task.status === 'open' || task.status === 'working')) this.store.updateTask(task.taskId, { status: 'working', recoveryCount: 0 })
        }
      } catch (error) {
        this.log('warn', 'pending delivery ' + delivery.deliveryId + ' still failing: ' + String(error && error.message ? error.message : error))
      }
    }
  }

  async startup() {
    if (this.started) return
    this.started = true
    try {
      await this.grants.reconcile()
      const hasActive = this.store.activeTasks().length > 0
      const hasPending = this.store.deliveries().length > 0
      if (!hasActive) {
        if (hasPending) {
          const onlyRetry = new AbortController()
          const retryTimer = setTimeout(() => onlyRetry.abort(), 30000)
          try {
            await this.retryDeliveries(onlyRetry.signal)
          } finally {
            clearTimeout(retryTimer)
          }
        }
        return
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      try {
        await this.retryDeliveries(controller.signal)
      } finally {
        clearTimeout(timer)
      }
      const active = this.store.activeTasks()
      const exhausted = active.filter(task => (task.recoveryCount || 0) >= MAX_RECOVERY_ATTEMPTS)
      const candidates = active.filter(task => (task.recoveryCount || 0) < MAX_RECOVERY_ATTEMPTS)
      for (const task of exhausted) {
        this.store.updateTask(task.taskId, { status: 'blocked', blockedReason: recoveryLimitReason() })
      }
      if (!candidates.length && !exhausted.length) return
      const superInfo = await this.ensure()
      const lines = []
      if (candidates.length) {
        lines.push('DSH 刚刚重启。以下是未完成的 task，请先按各自 executor 用 super_session_read 检查当前进度，再决定继续、关闭或标记 blocked。')
        lines.push('继续 worker 时，要求它先检查工作区、已改文件和测试，从中断处继续，不要重复已完成部分。')
        for (const task of candidates) {
          const nextRecovery = (task.recoveryCount || 0) + 1
          this.store.updateTask(task.taskId, { recoveryCount: nextRecovery })
          lines.push('- taskId=' + task.taskId + ' | executor=' + task.executor + ' | goal=' + task.goal + ' | acceptance=' + (task.acceptance || '(未填写)') + ' | recovery=' + nextRecovery + '/' + MAX_RECOVERY_ATTEMPTS)
        }
      }
      if (exhausted.length) {
        if (lines.length) lines.push('')
        lines.push('以下 task 已达到自动恢复上限（' + MAX_RECOVERY_ATTEMPTS + '/' + MAX_RECOVERY_ATTEMPTS + '），不会再自动恢复，已标记为 blocked，需要用户手动处理：')
        for (const task of exhausted) {
          lines.push('- taskId=' + task.taskId + ' | executor=' + task.executor + ' | goal=' + task.goal + ' | blockedReason=' + recoveryLimitReason())
        }
      }
      const content = [{ type: 'text', text: lines.join('\n') }]
      await this.ctx.sessionController.prompt({ requestId: newId(HOST_REQUEST_PREFIX), sessionId: superInfo.sessionId, mode: 'queue', content }, controller.signal)
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      this.log('error', 'startup recovery failed: ' + message)
      await this.notifyStartupFailure(message)
    }
  }

  async notifyStartupFailure(message) {
    const text = [
      'DSH 启动恢复失败，需要用户处理。',
      '错误：' + message,
      '未完成的 task 可能仍停留在原状态，自动恢复没有完成。请检查 Super Session 的 task 列表并手动处理。',
    ].join('\n')
    try {
      let sessionId = this.store.superSessionId
      if (!sessionId) {
        const info = await this.ensure()
        sessionId = info.sessionId
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      try {
        await this.ctx.sessionController.prompt({ requestId: newId(HOST_REQUEST_PREFIX), sessionId, mode: 'queue', content: [{ type: 'text', text }] }, controller.signal)
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      this.log('error', 'could not notify Super about startup failure: ' + String(error && error.message ? error.message : error))
    }
  }

  httpHandler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    if (!sameOrigin(req)) {
      jsonSend(res, 403, { error: 'cross-origin request rejected' })
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/health')) {
      jsonSend(res, 200, { ok: true, superSessionId: this.store.superSessionId || null })
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/state')) {
      jsonSend(res, 200, {
        superSessionId: this.store.superSessionId || null,
        tasks: this.store.tasks().map(taskSummary),
        pendingDeliveries: this.store.deliveries().length,
        grants: this.grants.list(),
        workerIdleNotifications: this.workerIdle.options,
        settings: this.store.settings(),
      })
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/settings')) {
      jsonSend(res, 200, this.store.settings())
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('/settings')) {
      readBody(req).then(raw => {
        let body
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          jsonSend(res, 400, { error: 'body must be JSON' })
          return
        }
        if (!body || typeof body.dispatchGuard !== 'boolean') {
          jsonSend(res, 400, { error: 'body.dispatchGuard must be a boolean' })
          return
        }
        jsonSend(res, 200, this.store.setDispatchGuard(body.dispatchGuard))
      }).catch(error => jsonSend(res, 400, { error: String(error && error.message ? error.message : error) }))
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('/ensure')) {
      readBody(req).then(async () => {
        try {
          const result = await this.ensure()
          jsonSend(res, 200, result)
        } catch (error) {
          jsonSend(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      }).catch(error => jsonSend(res, 400, { error: String(error && error.message ? error.message : error) }))
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/wechat/status')) {
      jsonSend(res, 200, this.wechat.statusView())
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('/wechat/pause')) {
      readBody(req).then(raw => {
        let body
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          jsonSend(res, 400, { error: 'body must be JSON' })
          return
        }
        if (!body || typeof body !== 'object' || typeof body.paused !== 'boolean') {
          jsonSend(res, 400, { error: 'body.paused must be a boolean' })
          return
        }
        const reason = typeof body.reason === 'string' ? body.reason : ''
        jsonSend(res, 200, this.wechat.setPaused(body.paused, { by: 'manual', reason }))
      }).catch(error => jsonSend(res, 400, { error: String(error && error.message ? error.message : error) }))
      return
    }
    if (req.method === 'POST' && (url.pathname.endsWith('/wechat/login') || url.pathname.endsWith('/wechat/logout') || url.pathname.endsWith('/wechat/start'))) {
      readBody(req).then(async () => {
        try {
          if (url.pathname.endsWith('/wechat/login')) {
            jsonSend(res, 200, await this.wechat.startLogin())
          } else if (url.pathname.endsWith('/wechat/logout')) {
            jsonSend(res, 200, await this.wechat.logout())
          } else {
            jsonSend(res, 200, await this.wechat.startFromCreds())
          }
        } catch (error) {
          jsonSend(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      }).catch(error => jsonSend(res, 400, { error: String(error && error.message ? error.message : error) }))
      return
    }
    jsonSend(res, 404, { error: 'not found' })
  }
}

export function apply(ctx, config) {
  const raw = config && typeof config === 'object' ? config : {}
  const stateDir = typeof raw.stateDir === 'string' && raw.stateDir.trim()
    ? resolve(raw.stateDir.trim())
    : join(dshHome(), 'state', 'super-session')
  const service = new SuperSessionService(ctx, stateDir, raw)
  ctx.on('agent/created', ({ agent }) => { service.onAgentCreated(agent) })
  try {
    service.dispatchGuard.installAll()
  } catch (error) {
    ctx.logger.warn('dsh-super-session: could not install the dispatch guard: %s', error && error.message ? error.message : error)
  }
  const disposeDispatchGuard = service.dispatchGuard.subscribe()
  ctx.effect(() => () => {
    try { disposeDispatchGuard() } catch { /* already removed */ }
    service.dispatchGuard.shutdown()
  }, 'dsh-super-session: dispatch guard')
  const disposeApprovals = service.approvals.subscribe()
  ctx.effect(() => () => {
    try { disposeApprovals() } catch { /* already removed */ }
    service.approvals.shutdown()
  }, 'dsh-super-session: approvals')
  const disposeWorkerIdle = service.workerIdle.subscribe()
  ctx.effect(() => () => {
    try { disposeWorkerIdle() } catch { /* already removed */ }
    service.workerIdle.shutdown()
  }, 'dsh-super-session: worker idle notifications')
  const disposeWechatEvents = service.wechat.subscribe()
  ctx.effect(() => () => {
    try { disposeWechatEvents() } catch { /* already removed */ }
    void service.wechat.shutdown()
  }, 'dsh-super-session: wechat')
  ctx.effect(() => () => service.grants.shutdown(), 'dsh-super-session: grants')
  service.wechat.start(1200)
  ctx.effect(() => () => {
    for (const dispose of service.disposers.splice(0)) {
      try { dispose() } catch { /* agent disposal already removed it */ }
    }
  }, 'dsh-super-session: tools')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: (req, res) => service.httpHandler(req, res) }), 'dsh-super-session: http api')
  const timer = setTimeout(() => { void service.startup() }, 1500)
  if (timer.unref) timer.unref()
  ctx.effect(() => () => clearTimeout(timer), 'dsh-super-session: startup recovery')
  ctx.logger.info('dsh-super-session ready: stateDir=%s', stateDir)
}
