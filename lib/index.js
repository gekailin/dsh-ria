// dsh-super-session host half.
//
// A globally unique Super Session: an ordinary top-level DSH Session running the
// PTC preset, with a manager prompt and five super_session_* tools installed on
// its Agent. It relays ordinary user messages to worker sessions and keeps its
// own task/delivery state in DSH_HOME/state/super-session/super.json.

import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { WechatService } from './wechat/service.mjs'

export const name = 'dsh-super-session'
export const inject = ['webServer', 'sessionController', 'workspaceRegistry']

const SUPER_PRESET = 'ptc'
const API_PREFIX = '/plugins/dsh-super-session/api'
const MEMORY_LIMIT = 4096
const TASK_STATUSES = ['open', 'working', 'blocked', 'done', 'cancelled']

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
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    recoveryCount: task.recoveryCount,
  }
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

  setSuper(sessionId, preset) {
    this.data.superSessionId = sessionId
    this.data.superPreset = preset
    this.data.createdAt = this.data.createdAt || now()
    this.save()
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
    if (patch.status !== undefined) task.status = patch.status
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
    '- A user request is ordinary conversation. If goal, scope, or acceptance is unclear, ask only the blocking questions first. Do not dispatch a vague task. If the user says to decide, record your assumptions and continue.',
    '- When a task is clear, restate the goal and acceptance once, then create a task. One task has exactly one executor: self, or one top-level worker session id.',
    '- Use super_session_status to find an appropriate top-level worker. Do not pick subagent sessions or the Super Session itself.',
    '- Use super_session_request to send the user words as an ordinary user message. The worker must not see any Super Session wrapper, attribution, or manager instructions. Send only what the user wants the worker to receive.',
    '- If a task is already running and the requirement changes, ask the user whether to queue or steer before using steer mode.',
    '- Monitor on demand with super_session_status and super_session_read. Do not poll in the background. When the user asks you to watch something, use the official schedule tools with target this_session; do not invent a timer.',
    '- On a restart/recovery message, read the worker first. If the work is done, close the task. If it needs the user, mark it blocked and report. If it can continue, send a continuation that tells the worker to inspect the workspace, changed files, and tests before resuming, and not repeat finished work.',
    '- When the user asks for a case set from experience, output it in the conversation: requirement, wrong approach, correct approach (usually what the user corrected). Save it to a file only when the user gives an explicit path; use normal file tools.',
    '- Keep memory.md for stable preferences only, never task progress or secrets. The current user message wins over memory.',
    '',
    '## Tools',
    'The host exposes super_session_task, super_session_status, super_session_request, super_session_read, and super_session_memory.',
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

class SuperSessionService {
  constructor(ctx, stateDir) {
    this.ctx = ctx
    this.stateDir = stateDir
    this.store = new SuperStore(stateDir)
    this.installed = new WeakSet()
    this.disposers = []
    this.creatingId = undefined
    this.ensuring = undefined
    this.started = false
    this.wechat = new WechatService({
      ctx,
      stateDir,
      ensureSuper: () => this.ensure().then(result => result.sessionId),
      getSuperId: () => this.store.superSessionId,
      log: (level, message) => this.log(level, 'wechat: ' + message),
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
      'Create, update, or close one Super task. A task has exactly one executor: self or a top-level worker session id. Use status=done/cancelled to close.',
      {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Existing task to update. Omit to create a new task.' },
          goal: { type: 'string', description: 'What must be achieved, in the user words.' },
          acceptance: { type: 'string', description: 'How completion is judged.' },
          executor: { type: 'string', description: 'self, or the sessionId of one top-level worker.' },
          status: { type: 'string', enum: TASK_STATUSES },
        },
        additionalProperties: false,
      },
      async args => this.toolTask(args),
    )

    register(
      'super_session_status',
      'Read task state, or list available top-level worker sessions. Optionally read one session state. This is passive and never resumes a cold session.',
      {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['tasks', 'sessions'] },
          sessionId: { type: 'string', description: 'With scope=sessions, read only this session state.' },
        },
        additionalProperties: false,
      },
      async (args, exec) => this.toolStatus(args, exec.signal),
    )

    register(
      'super_session_request',
      'Send an ordinary user message to one or more top-level worker sessions. The worker sees only the message content, never a Super/forward wrapper. Use mode=steer only when the user explicitly wants to interrupt.',
      {
        type: 'object',
        properties: {
          targetSessionIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 },
          message: { type: 'string', description: 'Convenience text content. Ignored when content is provided.' },
          content: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'DSH prompt content parts: text, image (mediaType/data/name), or file (receiptId).' },
          taskId: { type: 'string', description: 'Optional task to associate. Its executor must equal each target.' },
          mode: { type: 'string', enum: ['queue', 'steer'] },
        },
        required: ['targetSessionIds'],
        additionalProperties: false,
      },
      async (args, exec) => this.toolRequest(args, exec.signal),
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
    this.log('info', 'installed manager prompt and 5 tools on ' + sessionId)
  }

  async toolTask(args) {
    if (args.taskId) {
      const existing = this.store.task(args.taskId)
      if (!existing) throw new Error('task not found: ' + args.taskId)
      const patch = {}
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
      const task = this.store.updateTask(args.taskId, patch)
      return { task: taskSummary(task) }
    }
    const goal = asString(args.goal)
    const executor = asString(args.executor)
    if (!goal) throw new Error('goal is required when creating a task')
    if (!executor) throw new Error('executor is required when creating a task')
    if (args.status !== undefined && !TASK_STATUSES.includes(args.status)) throw new Error('invalid task status: ' + args.status)
    const task = this.store.addTask({ goal, acceptance: args.acceptance ? String(args.acceptance) : '', executor, status: args.status || 'open' })
    return { task: taskSummary(task) }
  }

  async listSessions(signal) {
    const page = await this.ctx.sessionController.list({}, signal)
    return Array.isArray(page && page.items) ? page.items : []
  }

  async toolStatus(args, signal) {
    const scope = args.scope === 'sessions' || args.sessionId ? 'sessions' : 'tasks'
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
      if (summary.updatedAt !== undefined) item.updatedAt = summary.updatedAt
      if (summary.cwd !== undefined) item.cwd = String(summary.cwd)
      if (summary.parentSessionId !== undefined) item.parentSessionId = String(summary.parentSessionId)
      return item
    })
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

  async toolRequest(args, signal) {
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
        if (task) this.store.updateTask(task.taskId, { status: 'working' })
        results.push({ targetSessionId: target, ok: true, requestId, taskId })
      } catch (error) {
        results.push({ targetSessionId: target, ok: false, requestId, taskId, error: String(error && error.message ? error.message : error) })
      }
    }
    return { results, pendingDeliveries: this.store.deliveries().length }
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
          if (task && (task.status === 'open' || task.status === 'working')) this.store.updateTask(task.taskId, { status: 'working' })
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
      const superInfo = await this.ensure()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      try {
        await this.retryDeliveries(controller.signal)
      } finally {
        clearTimeout(timer)
      }
      const candidates = this.store.activeTasks().filter(task => task.recoveryCount < 3)
      if (!candidates.length) return
      const lines = [
        'DSH 刚刚重启。以下是未完成的 task，请先按各自 executor 用 super_session_read 检查当前进度，再决定继续、关闭或标记 blocked。',
        '继续 worker 时，要求它先检查工作区、已改文件和测试，从中断处继续，不要重复已完成部分。',
      ]
      for (const task of candidates) {
        this.store.updateTask(task.taskId, { recoveryCount: task.recoveryCount + 1 })
        lines.push('- taskId=' + task.taskId + ' | executor=' + task.executor + ' | goal=' + task.goal + ' | acceptance=' + (task.acceptance || '(未填写)') + ' | recovery=' + (task.recoveryCount + 1) + '/3')
      }
      const content = [{ type: 'text', text: lines.join('\n') }]
      await this.ctx.sessionController.prompt({ requestId: newId('req_'), sessionId: superInfo.sessionId, mode: 'queue', content }, controller.signal)
    } catch (error) {
      this.log('error', 'startup recovery failed: ' + String(error && error.message ? error.message : error))
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
      })
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
  const service = new SuperSessionService(ctx, stateDir)
  ctx.on('agent/created', ({ agent }) => { service.onAgentCreated(agent) })
  const disposeWechatEvents = service.wechat.subscribe()
  ctx.effect(() => () => {
    try { disposeWechatEvents() } catch { /* already removed */ }
    void service.wechat.shutdown()
  }, 'dsh-super-session: wechat')
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
