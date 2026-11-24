import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../lib/index.js'
import { roleSessionTitle } from '../../lib/core/controller.mjs'
import { ticketBrief } from '../../lib/core/prompts.mjs'
import { isDeprecatedToolAlias } from '../../lib/tools/registry.mjs'

const RIA_ID = 'session-ria'
const MODEL_CATALOG = [
  { provider: 'provider-ok', model: 'model-vision', name: 'Vision Model', contextWindow: 128000, maxTokens: 8192 },
  { provider: 'provider-ok', model: 'model-fast', name: 'Fast Model', contextWindow: 64000, maxTokens: 4096 },
  { provider: 'provider-text', model: 'model-text-only', name: 'Text Only Model' },
  { provider: 'provider-ok', model: 'model-shared', name: 'Shared Model' },
  { provider: 'provider-text', model: 'model-shared', name: 'Shared Model' },
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
  const appends = []
  const steered = []
  const followups = []
  const creates = []
  const renames = []
  const effects = []
  const llmCalls = []
  const systemPrompts = new Map()
  const promptSections = new Map()
  let llmFailureCount = options.llmFailures || 0
  const archivedSessions = []
  const listeners = new Map()
  const summaries = []
  const sandboxModes = new Map()
  const approvalPolicies = new Map()
  const approvalCalls = []
  const modelCalls = { listProviders: 0, listModels: 0 }
  const titles = new Map([
    ['session-executor', 'Executor One'],
    ['session-no-image', 'Text Only'],
  ])
  const routes = []
  let riaId = RIA_ID
  let concluded = 0
  let promptFailure = undefined
  const queues = new Map(Object.entries(options.queues || {}).map(([id, queue]) => [String(id), Array.isArray(queue) ? queue.map(item => ({ ...item })) : null]))
  const runningOverrides = new Map()
  // SessionState.pendingInput belongs to the host state controller. Tests
  // inject the sampled value (approval / question / other) instead of pretending
  // the host produced it.
  const pendingInputs = id => {
    const injected = options.pendingInputs && options.pendingInputs[id]
    return Array.isArray(injected) ? injected.slice() : []
  }
  const updateQueueCalls = []
  const cancelCalls = []
  let cancelFailure = options.cancelFailure
  const models = new Map()
  models.set(riaId, { provider: 'provider-ok', model: 'model-vision' })
  models.set('session-executor', { provider: 'provider-ok', model: 'model-vision' })
  models.set('session-no-image', { provider: 'provider-text', model: 'model-text-only' })
  for (const item of options.extraSessions || []) {
    if (item.agentAvailable === false) continue
    const sid = String(item.sessionId)
    if (!models.has(sid)) models.set(sid, { provider: 'provider-ok', model: 'model-vision' })
  }

  const restrictions = new Map()
  // Delegation tools are host-global and mounted by the profile preset; tests
  // that exercise the Executor deny-list inject the ones their profile exposes.
  const globalTools = ['bash', 'read', 'write', 'edit', 'run_code', ...(options.extraGlobalTools || [])]
  const toolsApi = (id, tools) => ({
    register(definition) {
      if (options.rejectDuplicateTools && tools.has(definition.name)) {
        throw new Error('tool "' + definition.name + '" is already registered in this scope')
      }
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
    restrict(filter) {
      // Model dsh-tools/lib/index.js:453-467 exactly: a filter is validated
      // against inherited (global/preset) names only. A scope-local name such
      // as ria_sage_read, an unknown name, run_code, or an empty filter throws the
      // same way the host does. Without this validation a wrong-namespace
      // restriction silently no-ops in production yet passes the suite.
      const allow = filter && Array.isArray(filter.allow) ? filter.allow : undefined
      const deny = filter && Array.isArray(filter.deny) ? filter.deny : undefined
      if (allow === undefined && deny === undefined) {
        throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)')
      }
      const named = [...(allow || []), ...(deny || [])]
      if (named.includes('run_code')) {
        throw new Error('tools.restrict() cannot name reserved PTC mode presentation transport "run_code"; restrict end-capability tools instead')
      }
      const unknown = named.filter(name => !globalTools.includes(name))
      if (unknown.length > 0) {
        throw new Error('tools.restrict() names unknown global tool' + (unknown.length > 1 ? 's' : '') + ' ' + unknown.map(name => '"' + name + '"').join(', ') + '; known global tools: ' + globalTools.slice().sort().join(', '))
      }
      restrictions.set(String(id), filter && typeof filter === 'object' ? filter : {})
    },
    view(scope) {
      const filter = restrictions.get(String(id))
      const visible = new Map()
      // Model dsh-tools: an unscoped view is deployment-global and excludes
      // this agent's scoped registrations. Only a view for this agent includes
      // them, which is what the Advisor/Executor restriction code must request.
      const ownScope = scope !== undefined && String(scope.id) === String(id)
      for (const name of globalTools) {
        if (filter && Array.isArray(filter.allow) && !filter.allow.includes(name)) continue
        if (filter && Array.isArray(filter.deny) && filter.deny.includes(name)) continue
        visible.set(name, { name })
      }
      if (ownScope) for (const [name, definition] of tools) visible.set(name, definition)
      return { visible, restrictableNames: new Set(globalTools) }
    },
  })

  const registerPromptSection = (id, section) => {
    if (!Number.isFinite(section && section.order)) throw new TypeError('prompt section order must be finite')
    promptSections.set(String(id), section)
    systemPrompts.set(String(id), String(typeof section.text === 'function' ? section.text({}) : section.text))
    return () => {}
  }
  const riaAgent = {
    id: riaId,
    ctx: {
      tools: toolsApi(riaId, installed),
      systemPrompt: { section(section) { return registerPromptSection(riaAgent.id, section) } },
    },
    model: { current() { return models.get(String(riaAgent.id)) } },
    steer(message) { steered.push(message) },
    followup(message) { followups.push(message) },
    session: {
      snapshotEvents() { return options.sessionEvents && options.sessionEvents[riaId] ? options.sessionEvents[riaId].slice() : [] },
      append(event, data) {
        appends.push({ sessionId: riaId, args: [event, data] })
        if (event === 'sandbox/mode' && data) sandboxModes.set(riaId, data.mode)
        if (event === 'approval/policy' && data) approvalPolicies.set(riaId, data.policy)
        return { seq: 0, time: 1 }
      },
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
        systemPrompt: { section(section) { return registerPromptSection(id, section) } },
      },
      model: { current() { return model } },
      steer(message) { steered.push(message) },
      session: {
        snapshotEvents() { return options.sessionEvents && options.sessionEvents[id] ? options.sessionEvents[id].slice() : [] },
        append(event, data) {
          appends.push({ sessionId: id, args: [event, data] })
          if (event === 'sandbox/mode' && data) sandboxModes.set(id, data.mode)
          if (event === 'approval/policy' && data) approvalPolicies.set(id, data.policy)
          return { seq: 0, time: 1 }
        },
      },
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
    on(name, handler, listenerOptions) {
      const list = listeners.get(name) || []
      // The host orders waterfall listeners by registration; dsh-ria prepends
      // some of them (approval/request) so a test can prove the ordering.
      if (listenerOptions && listenerOptions.prepend) list.unshift(handler)
      else list.push(handler)
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
        if (options.noLlm) return undefined
        return {
          async *stream(request) {
            llmCalls.push(request)
            if (options.llmDelayMs) await new Promise(resolve => setTimeout(resolve, options.llmDelayMs))
            if (llmFailureCount > 0) {
              llmFailureCount -= 1
              throw new Error('llm stream failed')
            }
            const reply = typeof options.llmReply === 'function'
              ? options.llmReply(request)
              : (options.llmReply || JSON.stringify({ action: 'block', block: { reason: 'no reply configured' } }))
            yield { type: 'text-delta', text: String(reply) }
            yield { type: 'usage', usage: { input: 10, output: String(reply).length, total: 10 + String(reply).length } }
            yield { type: 'finish', reason: options.llmFinishReason || 'stop' }
          },
          listProviders() {
            modelCalls.listProviders += 1
            if (options.failListProviders) throw new Error('provider directory unavailable')
            return [{ id: 'provider-ok' }, { id: 'provider-text' }]
          },
          async listModels(provider) {
            modelCalls.listModels += 1
            if (options.failListModels) throw new Error('model directory unavailable')
            if (options.failListModelsProvider === provider) throw new Error('provider catalog unavailable')
            if (options.emptyModelCatalog) return []
            return MODEL_CATALOG.filter(item => item.provider === provider).map(item => ({
              ...item,
              provider: item.provider,
              id: item.model,
            }))
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
      get archivedSessionIds() { return [...(options.archivedSessionIds || []), ...archivedSessions] },
      async archiveSession(sessionId) { archivedSessions.push(String(sessionId)) },
      async create(path, title) {
        workspaceCalls.push({ path, title })
        return workspaceFor(path, title)
      },
      list() { return [...workspaces.values()] },
    },
    sandboxPolicy: {
      defaultMode: 'workspace-write',
      resolve(request) {
        const id = String(request && request.session && request.session.id || '')
        return { mode: sandboxModes.get(id) || 'workspace-write' }
      },
      overrideOf(session) { return sandboxModes.get(String(session && session.id || '')) },
    },
    approval: {
      config: { policy: 'ask' },
      effectivePolicy(session) { return approvalPolicies.get(String(session && session.id || '')) || 'ask' },
      overrideOf(session) { return approvalPolicies.get(String(session && session.id || '')) },
      setPolicy(agent, policy) {
        const id = String(agent && agent.id || '')
        approvalCalls.push({ sessionId: id, policy })
        approvalPolicies.set(id, policy)
      },
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
          if (sandboxModes.has(String(item.sessionId))) values.sandboxMode = sandboxModes.get(String(item.sessionId))
          if (approvalPolicies.has(String(item.sessionId))) values.approvalState = { policy: approvalPolicies.get(String(item.sessionId)), turnOpen: false }
          // Match the host SessionSummary shape: agentAvailable/running/blank are
          // always present, while parentSessionId/origin/cwd stay optional.
          return {
            agentAvailable: item.agentAvailable !== false,
            running: Boolean(item.running),
            blank: Boolean(item.blank),
            ...item,
            projections: { ...(item.projections || {}), values },
          }
        }
        return {
          items: [
            withModel({ sessionId: riaId, running: false, blank: false, updatedAt: 1, cwd: stateDir }),
            withModel({ sessionId: 'session-executor', running: true, blank: false, updatedAt: 2, cwd: stateDir, projections: { values: { title: 'Executor One' } } }),
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
        const summary = summaries.find(item => String(item.sessionId) === String(request.sessionId))
        if (summary) summary.blank = false
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
        const pendingInput = pendingInputs(id)
        // The event cursor is the log end ria_session_events starts from. Fixtures
        // with a seeded event log report its highest seq; the historical default
        // (1) stays for sessions without one.
        const recorded = options.sessionEvents && options.sessionEvents[id]
        let cursor = 1
        if (Array.isArray(recorded)) {
          for (const record of recorded) {
            const event = record && record.type === 'event' && record.event ? record.event : record
            const seq = event && Number.isSafeInteger(event.seq) ? event.seq : 0
            if (seq > cursor) cursor = seq
          }
        }
        if (!queues.has(id)) return { cursor, active: running, running, queue: null, pendingInput }
        return {
          cursor,
          active: running || queues.get(id).length > 0,
          running,
          queue: queues.get(id),
          pendingInput,
        }
      },
      cancel(request) {
        cancelCalls.push(request)
        if (cancelFailure) throw cancelFailure
        return { accepted: true }
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
        const all = Array.isArray(options.sessionEvents && options.sessionEvents[id]) ? options.sessionEvents[id] : []
        const unwrap = record => record && record.type === 'event' && record.event ? record.event : record
        const seqOf = record => {
          const event = unwrap(record)
          return event && Number.isSafeInteger(event.seq) ? event.seq : undefined
        }
        const maxSeq = all.reduce((max, record) => {
          const seq = seqOf(record)
          return seq !== undefined && seq > max ? seq : max
        }, 0)
        const throughSeq = Number.isSafeInteger(request && request.throughSeq) ? request.throughSeq : undefined
        const entries = all.map((record, index) => ({ record, seq: seqOf(record), index }))
        // The host applies the inclusive cut; records without a seq cannot be
        // placed on the timeline and are kept as-is (legacy fixture shape).
        let kept = entries.filter(entry => entry.seq === undefined || throughSeq === undefined || entry.seq <= throughSeq)
        if (kept.every(entry => entry.seq !== undefined)) kept = kept.slice().sort((a, b) => a.seq - b.seq)
        const maxMessages = Number.isSafeInteger(request && request.maxMessages) && request.maxMessages > 0
          ? request.maxMessages
          : undefined
        let hasMore = false
        if (maxMessages !== undefined && kept.length > maxMessages) {
          kept = kept.slice(-maxMessages)
          hasMore = true
        }
        return {
          records: kept.map(entry => entry.record),
          hasMore,
          cursor: throughSeq === undefined ? maxSeq : throughSeq,
        }
      },
      async wait(request, signal) {
        if (!signal || typeof signal.throwIfAborted !== 'function') {
          throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
        }
        signal.throwIfAborted()
        const id = String(request && request.sessionId ? request.sessionId : '')
        if (options.onWait) {
          const custom = await options.onWait(request)
          if (custom) return custom
        }
        const records = options.waitRecords && options.waitRecords[id]
        return {
          reason: 'idle',
          state: { cursor: 10, active: false, running: false, queue: null, pendingInput: pendingInputs(id) },
          output: { records: Array.isArray(records) ? records.slice() : [], truncated: false },
        }
      },
      async projections(request) {
        const id = request && request.sessionId ? String(request.sessionId) : ''
        const current = models.get(id) || { provider: 'provider-ok', model: 'model-vision' }
        const values = { modelSelection: { next: current } }
        const title = titles.get(id)
        if (title) values.title = title
        if (sandboxModes.has(id)) values.sandboxMode = sandboxModes.get(id)
        if (approvalPolicies.has(id)) values.approvalState = { policy: approvalPolicies.get(id), turnOpen: false }
        return { kind: 'sequenced', values }
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

  // Some host plugins register their waterfall listener before profile plugins
  // load; dsh-api-remotes holds approval/request for the browser this way. Tests
  // that need that ordering declare listeners here.
  for (const [name, handler] of Object.entries(options.preListeners || {})) {
    const list = listeners.get(name) || []
    list.push(handler)
    listeners.set(name, list)
  }

  const service = apply(ctx, { stateDir, ...(options.autoTagTurnThreshold !== undefined ? { autoTagTurnThreshold: options.autoTagTurnThreshold } : {}) })
  await service.ensure()
  // Production Advisor planning is stateless (lib/core/controller.mjs). Most
  // suites here test Router/Executor mechanics and need a planned ticket whose
  // WorkOrder they control, plus an advisor-shaped session for the
  // ria_ticket_plan/ria_ticket_dispatch tool surface. This scaffolding keeps that
  // surface in the fixture only; suites that exercise stateless planning pass
  // advisorPlan: 'stateless' and use the real LLM path.
  let advisorSeq = 0
  const createAdvisorSession = async (scope = 'global') => {
    const sessionId = 'session-advisor-' + (++advisorSeq)
    const cwd = join(stateDir, 'advisors', String(advisorSeq))
    service.controller.setAdvisor(scope, sessionId, { cwd })
    const created = await service.controller.createSession({ sessionId, cwd, agentPreset: 'ptc', title: roleSessionTitle('advisor') })
    service.controller.install(created.agent, 'advisor')
    return sessionId
  }
  const advisorSession = async (scope = 'global') => {
    const existing = service.controller.advisor(scope)
    if (existing && existing.sessionId) return String(existing.sessionId)
    return await createAdvisorSession(scope)
  }
  if (options.advisorPlan !== 'stateless') {
    service.controller.createAdvisorForTicket = async (ticket, meta = {}, request = null, extra = '') => {
      const ticketId = String(ticket.ticketId)
      const sessionId = await createAdvisorSession('ticket:' + ticketId)
      service.controller.setAdvisor('global', sessionId, { cwd: join(stateDir, 'advisors') })
      service.controller.state.setTicketMeta(ticketId, { advisorSessionId: sessionId })
      const lines = [ticketBrief(ticket, request, meta)]
      if (extra) lines.push('', extra)
      let snapshot = { snapshot: '', degraded: false, files: [] }
      try { snapshot = service.controller.cognition.retrieve({ workspace: meta.projectCwd, goal: ticket.goal }) } catch { snapshot = { snapshot: '', degraded: true, files: [] } }
      lines.push('', '[认知快照]', snapshot.snapshot || '（无可用认知）')
      if (snapshot.degraded) lines.push('', '[认知状态] degraded：认知检索失败，只按最小原则执行；请在 WorkOrder 中显式标注 cognition_status: degraded。')
      await service.controller.promptSession(sessionId, lines.join('\n'))
      return { sessionId, created: true, preset: 'ptc', degraded: Boolean(snapshot.degraded) }
    }
  }
  // Automation changes the approval waterfall, so every existing test runs
  // with the host-native behaviour unless it opts in explicitly.
  service.store.setSettings({ approvalAutomation: options.approvalAutomation === true })
  const toolsFor = sessionId => {
    const id = String(sessionId)
    return id === String(riaAgent.id) ? installed : agentTools.get(id)
  }
  const callAs = async (sessionId, name, args) => {
    const agent = makeAgent(String(sessionId))
    const tools = toolsFor(sessionId)
    const definition = tools && tools.get(name)
    if (!agent || !definition) throw new Error('tool not installed for ' + String(sessionId) + ': ' + name)
    const result = await definition.execute(args, {
      agent,
      signal: new AbortController().signal,
      concludeTurn() { concluded += 1 },
    })
    // Production reports are evidence only. The real host emits turn/end after
    // the executor finishes; the fixture models that boundary for final reports
    // so existing callAs-based suites observe the same settlement.
    if (name === 'ria_executor_report' && result && result.ok && ['done', 'blocked', 'failed'].includes(args && args.status)) {
      await service.controller.settleTicketFromExecutorEvent(String(sessionId), {
        type: 'turn/end',
        data: { ticketId: args && args.ticketId, turn: 1, reason: { kind: 'completed' } },
      })
    }
    return result
  }
  const call = async (name, args) => await callAs(riaAgent.id, name, args)
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
    appends,
    approvalCalls,
    steered,
    followups,
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
    llmCalls,
    systemPrompts,
    assembleSystemPrompt(sessionId, context = {}) {
      const section = promptSections.get(String(sessionId))
      if (!section) return ''
      return String(typeof section.text === 'function' ? section.text(context) : section.text)
    },
    archivedSessions,
    riaAgent,
    agentFor(sessionId) { return makeAgent(String(sessionId)) },
    call,
    callAs,
    advisorSession,
    cleanup,
    visibleTools(sessionId) {
      const agent = makeAgent(String(sessionId))
      if (!agent) return []
      return [...agent.ctx.tools.view(agent).visible.keys()].filter(name => !isDeprecatedToolAlias(name))
    },
    queues,
    restrictions,
    modelCalls,
    setRunning(sessionId, value) { runningOverrides.set(String(sessionId), Boolean(value)) },
    setRiaSession(sessionId) {
      riaId = String(sessionId)
      riaAgent.id = riaId
      if (!models.has(riaId)) models.set(riaId, { provider: 'provider-ok', model: 'model-vision' })
      service.store.setRia(riaId, 'ptc')
    },
    updateQueueCalls,
    cancelCalls,
    setCancelFailure(error) { cancelFailure = error },
    setPromptFailure(error) { promptFailure = error },
    get concluded() { return concluded },
    resetConcluded() { concluded = 0 },
  }
}
