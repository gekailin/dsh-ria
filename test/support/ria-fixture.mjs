import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../lib/index.js'

const RIA_ID = 'session-ria'
const MODEL_CATALOG = [
  { provider: 'provider-ok', model: 'model-vision' },
  { provider: 'provider-ok', model: 'model-fast' },
  { provider: 'provider-text', model: 'model-text-only' },
  { provider: 'provider-ok', model: 'model-shared' },
  { provider: 'provider-text', model: 'model-shared' },
]
const DEFAULT_IMAGE_LIMITS = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 4096,
  maxImagePixels: 64000000,
  maxImageDimension: 65535,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/**
 * Minimal fake ctx for ria_spawn / attachment tests. It keeps the session
 * list in memory, records prompts and create/rename calls, and never starts a
 * real model or session.
 */
export async function createFixture(options = {}) {
  const ownsStateDir = !options.stateDir
  const stateDir = options.stateDir || mkdtempSync(join(tmpdir(), 'dsh-ria-fixture-'))
  const installed = new Map()
  const agentTools = new Map()
  const prompts = []
  const steered = []
  const creates = []
  const renames = []
  const effects = []
  const listeners = new Map()
  const summaries = []
  const titles = new Map([
    ['session-worker', 'Worker One'],
    ['session-no-image', 'Text Only'],
  ])
  const routes = []
  let riaId = RIA_ID
  let concluded = 0
  let promptFailure = undefined
  const queues = new Map(Object.entries(options.queues || {}).map(([id, queue]) => [String(id), Array.isArray(queue) ? queue.map(item => ({ ...item })) : null]))
  const runningOverrides = new Map()
  const updateQueueCalls = []
  const models = new Map()
  models.set(riaId, { provider: 'provider-ok', model: 'model-vision' })
  models.set('session-worker', { provider: 'provider-ok', model: 'model-vision' })
  models.set('session-no-image', { provider: 'provider-text', model: 'model-text-only' })

  const restrictions = new Map()
  const globalTools = ['bash', 'read', 'write', 'edit', 'run_code']
  const toolsApi = (id, tools) => ({
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
    restrict(filter) {
      restrictions.set(String(id), filter && typeof filter === 'object' ? filter : {})
    },
    view() {
      const filter = restrictions.get(String(id))
      const visible = new Map()
      for (const name of globalTools) {
        if (filter && Array.isArray(filter.allow) && !filter.allow.includes(name)) continue
        if (filter && Array.isArray(filter.deny) && filter.deny.includes(name)) continue
        visible.set(name, { name })
      }
      for (const [name, definition] of tools) visible.set(name, definition)
      return { visible }
    },
  })

  const riaAgent = {
    id: riaId,
    ctx: {
      tools: toolsApi(riaId, installed),
      systemPrompt: { section() { return () => {} } },
    },
    model: { current() { return models.get(String(riaAgent.id)) } },
    steer(message) { steered.push(message) },
    session: {
      snapshotEvents() { return options.sessionEvents && options.sessionEvents[riaId] ? options.sessionEvents[riaId].slice() : [] },
      append() { return { seq: 0, time: 1 } },
    },
  }

  const makeAgent = id => {
    if (id === riaId) return riaAgent
    const model = models.get(id)
    if (!model) return undefined
    let tools = agentTools.get(id)
    if (!tools) {
      tools = new Map()
      agentTools.set(id, tools)
    }
    return {
      id,
      ctx: {
        tools: toolsApi(id, tools),
        systemPrompt: { section() { return () => {} } },
      },
      model: { current() { return model } },
      session: { snapshotEvents() { return options.sessionEvents && options.sessionEvents[id] ? options.sessionEvents[id].slice() : [] }, append() { return { seq: 0, time: 1 } } },
    }
  }

  const workspaces = new Map()
  const workspaceCalls = []
  const workspaceAttachments = []
  let workspaceSeq = 0
  const workspaceFor = (path, title) => {
    for (const existing of workspaces.values()) if (existing.path === path) return existing
    const id = path === stateDir ? 'workspace-ria' : 'workspace-' + (++workspaceSeq)
    const entity = {
      id,
      path,
      title,
      sessionIds: [],
      async attachSession(sessionId) {
        if (options.failAttach) throw new Error(options.failAttach)
        const sid = String(sessionId)
        if (entity.sessionIds.includes(sid)) return
        entity.sessionIds.push(sid)
        workspaceAttachments.push({ key: id + ':' + sid, workspaceId: id, sessionId: sid })
      },
    }
    workspaces.set(id, entity)
    return entity
  }

  const schedules = []
  const scheduleCalls = []
  let scheduleSeq = 0
  const scheduleFailure = options.scheduleFailure
  const failSchedule = (operation, request) => {
    scheduleCalls.push({ operation, request })
    if (typeof scheduleFailure === 'function') scheduleFailure(operation, request)
    else if (scheduleFailure) throw scheduleFailure
  }
  const scheduleClone = task => JSON.parse(JSON.stringify(task))
  const scheduleTimingAt = timing => {
    if (!timing || typeof timing !== 'object') throw Object.assign(new Error('timing required'), { code: 'invalid_rule' })
    if (timing.kind === 'after') return Date.now() + Number(timing.after_seconds || 0) * 1000
    if (timing.kind === 'at') return Number(timing.at)
    if (timing.kind === 'rrule') {
      const match = /^DTSTART;TZID=Asia\/Shanghai:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/m.exec(String(timing.rrule || ''))
      if (!match) throw Object.assign(new Error('bad rrule'), { code: 'invalid_rule' })
      const [, year, month, day, hour, minute, second] = match
      return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second))
    }
    throw Object.assign(new Error('bad timing'), { code: 'invalid_rule' })
  }
  const scheduleService = {
    async create(request) {
      failSchedule('create', request)
      if (typeof request.prompt !== 'string' || !request.prompt) throw Object.assign(new Error('prompt required'), { code: 'invalid_prompt' })
      if (!request.target || request.target.kind !== 'session') throw Object.assign(new Error('target required'), { code: 'invalid_rule' })
      const scheduledAt = scheduleTimingAt(request.timing)
      const now = Date.now()
      const task = {
        id: 'schedule-' + (++scheduleSeq),
        title: request.title,
        prompt: request.prompt,
        target: JSON.parse(JSON.stringify(request.target)),
        timing: JSON.parse(JSON.stringify(request.timing)),
        ...(request.timing.kind === 'rrule' ? { rrule: request.timing.rrule } : {}),
        status: 'active',
        scheduledAt: new Date(scheduledAt).toISOString(),
        updatedAt: new Date(now).toISOString(),
      }
      schedules.push(task)
      return scheduleClone(task)
    },
    async list(request = {}) {
      failSchedule('list', request)
      const limit = request.limit === undefined ? 100 : Number(request.limit)
      const offset = request.offset === undefined ? 0 : Number(request.offset)
      let items = schedules.slice()
      if (request.active === true) items = items.filter(item => item.status === 'active')
      if (request.active === false) items = items.filter(item => item.status !== 'active')
      const total = items.length
      return { items: items.slice(offset, offset + limit).map(scheduleClone), shown: Math.max(0, Math.min(limit, total - offset)), total, limit, offset }
    },
    async view(request) {
      failSchedule('view', request)
      const task = schedules.find(item => item.id === String(request && request.id))
      return task ? scheduleClone(task) : { id: String(request && request.id), code: 'schedule_not_found' }
    },
    async edit(request, actorSessionId, signal) {
      failSchedule('edit', request)
      if (signal) signal.throwIfAborted()
      const index = schedules.findIndex(item => item.id === String(request && request.id))
      if (index < 0) return { id: String(request && request.id), code: 'schedule_not_found' }
      if (request.action === 'delete') {
        schedules.splice(index, 1)
        return { id: request.id, deleted: true }
      }
      if (request.action !== 'update') throw Object.assign(new Error('bad action'), { code: 'invalid_rule' })
      const patch = request.patch || {}
      if (!Object.keys(patch).length) throw Object.assign(new Error('patch required'), { code: 'invalid_rule' })
      const task = schedules[index]
      for (const key of ['title', 'prompt', 'target', 'timing']) if (key in patch) task[key] = JSON.parse(JSON.stringify(patch[key]))
      if ('timing' in patch) {
        task.scheduledAt = new Date(scheduleTimingAt(patch.timing)).toISOString()
        if (patch.timing.kind === 'rrule') task.rrule = patch.timing.rrule
      }
      if ('active' in patch) task.status = patch.active ? 'active' : 'paused'
      task.updatedAt = new Date().toISOString()
      return scheduleClone(task)
    },
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: { list() { return [] } },
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
    effect(factory) {
      const dispose = factory()
      if (dispose) effects.push(dispose)
      return dispose
    },
    get(name) {
      if (name === 'attachments') {
        return {
          imageLimits: options.imageLimits || DEFAULT_IMAGE_LIMITS,
          validateImageBatch(inputs) {
            if (options.rejectBatch) throw new Error(options.rejectBatch)
            const limits = this.imageLimits
            if (inputs.length > limits.maxImagesPerMessage) throw Object.assign(new Error('too many images'), { code: 'TOO_MANY_IMAGES' })
            const bytes = inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
            if (bytes > limits.maxMessageImageBytes) throw Object.assign(new Error('too many image bytes'), { code: 'IMAGES_TOO_LARGE' })
            for (const input of inputs) if (!limits.mediaTypes.includes(input.mediaType)) throw Object.assign(new Error('bad image type'), { code: 'UNSUPPORTED_IMAGE_TYPE' })
          },
          async validateImage(input) {
            if (options.rejectImage) throw new Error(options.rejectImage)
            if (input.data.byteLength > this.imageLimits.maxImageBytes) throw Object.assign(new Error('image too large'), { code: 'IMAGE_TOO_LARGE' })
          },
        }
      }
      if (name === 'llm') {
        return {
          listProviders() { return [{ id: 'provider-ok' }, { id: 'provider-text' }] },
          async listModels(provider) {
            if (options.failListModelsProvider === provider) throw new Error('provider catalog unavailable')
            return MODEL_CATALOG.filter(item => item.provider === provider).map(item => ({ ...item, id: item.model }))
          },
          async resolveModelInfo(provider, model) {
            return { provider, model, inputModalities: provider === 'provider-text' ? ['text'] : ['text', 'image'] }
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection() { return { provider: 'provider-ok', model: 'model-vision' } } }
      }
      if (name === 'schedule') return options.noSchedule ? undefined : scheduleService
      return undefined
    },
    inject(names, factory) {
      if (Array.isArray(names) && names.includes('schedule') && !options.noSchedule) {
        factory({
          get(name) { return name === 'schedule' ? scheduleService : ctx.get(name) },
          effect(inner) { return ctx.effect(inner) },
        })
      }
      return { dispose() {} }
    },
    webServer: { register(route) { routes.push(route); return () => {} } },
    workspaceRegistry: {
      get archivedSessionIds() { return options.archivedSessionIds || [] },
      async create(path, title) {
        workspaceCalls.push({ path, title })
        return workspaceFor(path, title)
      },
      list() { return [...workspaces.values()] },
    },
    sandboxPolicy: {
      resolve() { return { mode: 'workspace-write' } },
      overrideOf() { return undefined },
    },
    approval: {
      effectivePolicy() { return 'ask' },
      overrideOf() { return undefined },
      setPolicy() {},
    },
    sessionController: {
      async create(request) {
        creates.push(request)
        if (request.workspaceId) {
          const sessionId = String(request.sessionId || riaId)
          riaId = sessionId
          riaAgent.id = sessionId
          if (!models.has(String(sessionId))) models.set(String(sessionId), { provider: 'provider-ok', model: 'model-vision' })
          return { sessionId, agentPreset: request.agentPreset }
        }
        if (options.failCreate) throw options.failCreate
        const sessionId = String(request.sessionId || ('session-spawn-' + (creates.filter(item => !item.workspaceId).length)))
        const summary = {
          sessionId,
          running: false,
          blank: true,
          updatedAt: Date.now(),
          cwd: request.cwd,
          projections: { values: {} },
        }
        summaries.push(summary)
        models.set(sessionId, { provider: 'provider-ok', model: 'model-vision' })
        const agent = makeAgent(sessionId)
        if (agent) for (const handler of listeners.get('agent/created') || []) handler({ agent })
        return { sessionId, ...(request.agentPreset ? { agentPreset: request.agentPreset } : {}) }
      },
      async resolveAgent(id) {
        const agent = makeAgent(String(id))
        if (!agent) return { error: { code: 'session/not-found', message: 'not found' } }
        return { agent }
      },
      async list() {
        const withModel = item => {
          const current = models.get(String(item.sessionId))
          const values = { ...(item.projections && item.projections.values ? item.projections.values : {}) }
          const title = titles.get(String(item.sessionId))
          if (title) values.title = title
          if (current) values.modelSelection = { next: current }
          return { ...item, projections: { ...(item.projections || {}), values } }
        }
        return {
          items: [
            withModel({ sessionId: riaId, running: false, blank: false, updatedAt: 1, cwd: stateDir }),
            withModel({ sessionId: 'session-worker', running: true, blank: false, updatedAt: 2, cwd: stateDir, projections: { values: { title: 'Worker One' } } }),
            withModel({ sessionId: 'session-no-image', running: false, blank: false, updatedAt: 3, cwd: stateDir, projections: { values: { title: 'Text Only' } } }),
            { sessionId: 'session-subagent', running: false, blank: false, updatedAt: 4, cwd: stateDir, origin: 'subagent' },
            ...(options.extraSessions || []).map(withModel),
            ...summaries.map(withModel),
          ],
        }
      },
      async prompt(request, signal) {
        // The host prompt() calls signal.throwIfAborted() unconditionally, so a
        // missing signal is a programming error rather than "not cancellable".
        if (!signal || typeof signal.throwIfAborted !== 'function') {
          throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
        }
        signal.throwIfAborted()
        if (promptFailure) throw promptFailure
        prompts.push(request)
        if (options.onPrompt) await options.onPrompt(request)
        return { accepted: true }
      },
      async rename(request) {
        renames.push(request)
        if (options.failRename) throw options.failRename
        const title = String(request.title)
          .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu, '')
          .replace(/\s+/gu, ' ')
          .trim()
        if (!title) throw Object.assign(new Error('session title must contain visible characters'), { code: 'session/title-invalid' })
        titles.set(String(request.sessionId), title)
        const summary = summaries.find(item => item.sessionId === request.sessionId)
        if (summary) summary.projections.values.title = title
        return { title, seq: 1 }
      },
      async selectModel(request) {
        if (options.failSelectModel) throw options.failSelectModel
        const id = String(request.sessionId)
        if (!models.has(id)) throw Object.assign(new Error('session not found'), { code: 'session/not-found' })
        const available = MODEL_CATALOG.some(item => item.provider === request.provider && item.model === request.model)
        if (!available) throw Object.assign(new Error('model is not available: ' + request.provider + '/' + request.model), { code: 'session/model-unavailable' })
        const selected = { provider: request.provider, model: request.model }
        if (request.reasoningEffort) selected.reasoningEffort = request.reasoningEffort
        models.set(id, selected)
        const summary = summaries.find(item => String(item.sessionId) === id)
        if (summary) summary.projections.values.modelSelection = { next: selected }
        return { selected }
      },
      async state(request, signal) {
        // The host calls signal.throwIfAborted() unconditionally, so a missing
        // signal is a programming error rather than "not cancellable".
        if (!signal || typeof signal.throwIfAborted !== 'function') {
          throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
        }
        signal.throwIfAborted()
        const failure = typeof options.stateFailure === 'function' ? options.stateFailure(request) : options.stateFailure
        if (failure) throw failure
        const id = String(request && request.sessionId)
        const running = runningOverrides.has(id)
          ? Boolean(runningOverrides.get(id))
          : queues.has(id) ? (options.running === undefined ? true : Boolean(options.running)) : false
        if (!queues.has(id)) return { cursor: 1, active: running, running, queue: null, pendingInput: [] }
        return {
          cursor: 1,
          active: running || queues.get(id).length > 0,
          running,
          queue: queues.get(id),
          pendingInput: [],
        }
      },
      async updateQueue(request) {
        updateQueueCalls.push(request)
        const failure = typeof options.failUpdateQueue === 'function' ? options.failUpdateQueue(request) : options.failUpdateQueue
        if (failure) throw failure
        const queue = queues.get(String(request.sessionId))
        if (!Array.isArray(queue)) throw Object.assign(new Error('session has no live queue'), { code: 'session/queue-item-not-found' })
        const index = queue.findIndex(item => String(item.id) === String(request.itemId))
        if (index < 0) throw Object.assign(new Error('queue item not found'), { code: 'session/queue-item-not-found' })
        const removed = queue.splice(index, 1)[0]
        return { accepted: true, removed }
      },
      async events(request) {
        const id = request && request.address ? String(request.address.sessionId) : ''
        const events = options.sessionEvents && options.sessionEvents[id]
        return { records: Array.isArray(events) ? events.slice() : [], hasMore: false, cursor: 0 }
      },
      async projections(request) {
        const id = request && request.sessionId ? String(request.sessionId) : ''
        const current = models.get(id) || { provider: 'provider-ok', model: 'model-vision' }
        return { kind: 'sequenced', values: { modelSelection: { next: current } } }
      },
    },
  }

  // Drive plugin hooks the way the agent loop does: a waterfall for pre-step
  // (each handler receives next()) and a serial pass for turn-stopping.
  const emit = async (name, payload, base) => {
    const handlers = [...(listeners.get(name) || [])]
    if (name === 'agent/turn-stopping') {
      for (const handler of handlers) await handler(payload)
      return undefined
    }
    const fallback = base || (async () => ({ kind: 'enter', messages: [] }))
    const dispatch = async index => {
      if (index >= handlers.length) return fallback()
      return handlers[index](payload, () => dispatch(index + 1))
    }
    return dispatch(0)
  }

  const service = apply(ctx, { stateDir })
  await service.ensure()
  const call = async (name, args) => {
    const definition = installed.get(name)
    if (!definition) throw new Error('tool not installed: ' + name)
    return await definition.execute(args, {
      agent: riaAgent,
      signal: new AbortController().signal,
      concludeTurn() { concluded += 1 },
    })
  }
  const cleanup = (cleanupOptions = {}) => {
    try { service.wechat.shutdown() } catch { /* already stopped */ }
    try { service.shutdownOutbox() } catch { /* already stopped */ }
    for (const dispose of effects.splice(0).reverse()) {
      try { dispose() } catch { /* already disposed */ }
    }
    if (ownsStateDir && cleanupOptions.keepState !== true) rmSync(stateDir, { recursive: true, force: true })
  }
  return {
    stateDir,
    ctx,
    service,
    installed,
    agentTools,
    prompts,
    steered,
    emit,
    creates,
    renames,
    summaries,
    workspaces,
    workspaceCalls,
    workspaceAttachments,
    routes,
    schedules,
    scheduleCalls,
    riaAgent,
    call,
    cleanup,
    visibleTools(sessionId) {
      const agent = makeAgent(String(sessionId))
      if (!agent) return []
      return [...agent.ctx.tools.view().visible.keys()]
    },
    queues,
    setRunning(sessionId, value) { runningOverrides.set(String(sessionId), Boolean(value)) },
    setRiaSession(sessionId) {
      riaId = String(sessionId)
      riaAgent.id = riaId
      if (!models.has(riaId)) models.set(riaId, { provider: 'provider-ok', model: 'model-vision' })
      service.store.setRia(riaId, 'ptc')
    },
    updateQueueCalls,
    setPromptFailure(error) { promptFailure = error },
    get concluded() { return concluded },
    resetConcluded() { concluded = 0 },
  }
}
