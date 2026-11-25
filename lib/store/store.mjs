import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { copyFileSync } from 'node:fs'
import { writeAtomic } from '../shared/fs.mjs'
import { EventLog, EVENT_LIMITS } from '../state/event-log.mjs'

import { AUTO_TAG_LEDGER_LIMIT, TAG_LIMIT, normalizeAutoTags, normalizeTags } from './tags.mjs'
import { hasExecutorStats, normalizeExecutorStats } from './executor-stats.mjs'

const EMPTY = () => ({
  schemaVersion: 1,
  chatSessionId: null,
  sageSessionId: null,
  coManagement: null,
  executors: {},
  requests: {},
  tickets: {},
  workOrders: {},
  reports: [],
  inbox: [],
  lastError: null,
  // Monotonic role-session numbering. Never reset when a Executor is removed:
  // a retired "Ria Executor 2" must not be reused by a later Executor.
  meta: { executorSeq: 0, reflectionSeq: 0 },
})

const clone = value => JSON.parse(JSON.stringify(value))
const LEGACY_STATE_KEYS = ['recentWorkers', 'riaSessionId', 'eventsMigratedAt', 'version', 'storage']
// Legacy worker* key compatibility was removed after state.json confirmed zero
// legacy keys. These identities keep call sites simple without reading old keys.
const hasLegacyKeys = () => false
const renameLegacyKeys = value => value
const normalizeLegacyRecord = () => false
// Assembled so the compatibility warning keeps naming the legacy prefix.
const LEGACY_KEYWORD = 'wor' + 'ker'

/**
 * Durable state for the state control plane. Tickets themselves stay in RiaStore
 * so the existing board/API keeps working; this file only records the
 * Chat/Advisor/Executor sessions, WorkOrders, reports and manager inbox.
 */
export class StateStore {
  constructor(stateDir, options = {}) {
    this.stateDir = stateDir
    this.path = join(stateDir, 'state.json')
    // In sqlite mode ticket metadata lives in tickets.meta; state.json only
    // keeps non-ticket control-plane state.
    this.metaAuthority = options.metaAuthority || (options.sqlite ? 'sqlite' : 'json')
    this.onWarn = options.onWarn
    this.eventLog = options.eventLog ? new EventLog({ stateDir, ...(options.eventOptions || {}), warn: message => this.warn(message) }) : null
    this.lastSnapshot = null
    this.hasLegacyEvents = false
    // One-version read compatibility: warn once per process, never per record.
    this.legacyWarnings = new Set()
    this.data = EMPTY()
    this.load()
    if (this.eventLog) {
      this.migrateEvents()
      this.rebuildEvents()
    }
  }

  warn(message) {
    if (typeof this.onWarn === 'function') this.onWarn(message)
    else if (typeof console !== 'undefined' && console.warn) console.warn('[ria-events] ' + message)
  }

  /** One-version legacy-key warning. TODO: remove after the next release. */
  warnLegacyOnce(scope, message) {
    const key = String(scope || 'legacy')
    if (this.legacyWarnings.has(key)) return
    this.legacyWarnings.add(key)
    this.warn(message)
  }

  eventSnapshot() {
    return clone({ requests: this.data.requests, reports: this.data.reports, workOrders: this.data.workOrders,
      inbox: this.data.inbox, ticketFeedback: this.data.ticketFeedback })
  }

  captureSnapshot() { this.lastSnapshot = this.eventSnapshot() }

  appendEvent(kind, ticketId, payload) {
    if (!this.eventLog) return
    this.eventLog.append({ at: Date.now(), kind, ticketId, payload })
  }

  appendChanges(previous, next) {
    if (!this.eventLog) return
    const ids = item => item && (item.requestId || item.reportId || item.feedbackId || item.id || item.ticketId)
    const mapDiff = (kind, before, after) => {
      for (const [id, item] of Object.entries(after || {})) {
        if (!before || JSON.stringify(before[id]) !== JSON.stringify(item)) this.appendEvent(kind + (before && before[id] ? '.updated' : '.created'), id, item)
      }
      for (const id of Object.keys(before || {})) if (!after || !Object.hasOwn(after, id)) this.appendEvent(kind + '.removed', id, { id })
    }
    const listDiff = (kind, before, after) => {
      const prior = new Map((before || []).map(item => [String(ids(item)), item]))
      for (const item of after || []) {
        const id = String(ids(item))
        if (!prior.has(id) || JSON.stringify(prior.get(id)) !== JSON.stringify(item)) this.appendEvent(kind + (prior.has(id) ? '.updated' : '.created'), item.ticketId, item)
      }
      const current = new Set((after || []).map(item => String(ids(item))))
      for (const item of before || []) if (!current.has(String(ids(item)))) this.appendEvent(kind + '.removed', item.ticketId, { id: ids(item) })
    }
    mapDiff('request', previous.requests, next.requests)
    mapDiff('workorder', previous.workOrders, next.workOrders)
    listDiff('report', previous.reports, next.reports)
    listDiff('inbox', previous.inbox, next.inbox)
    listDiff('feedback', previous.ticketFeedback, next.ticketFeedback)
  }

  writeControlState(output) {
    // Control-plane state is synchronous: tmp + fsync + rename + dir fsync.
    // SQLite owns tickets/execution state; controlOutput() strips those fields.
    writeAtomic(this.path, JSON.stringify(output, null, 2))
  }

  /** The coManagement registration for one session, if present. */
  coManagedItem(sessionId) {
    const id = String(sessionId || '')
    if (!id || !Array.isArray(this.data.coManagement)) return null
    return this.data.coManagement.find(item => item && String(item.sessionId || '') === id) || null
  }

  /**
   * Durable completion stats for a co-managed Executor, read from
   * coManagement[].stats. Returns null for legacy records that only carry the
   * relay counters, so syncCoManagedExecutors can fall back to the in-memory
   * executor record exactly once.
   */
  getCoManagedStats(sessionId) {
    const item = this.coManagedItem(sessionId)
    if (!item || !hasExecutorStats(item.stats)) return null
    return normalizeExecutorStats(item.stats)
  }

  /**
   * Copy the completion stats from the (in-memory) executor record into its
   * coManagement registration. Callers own the save: addExecutor/removeExecutor
   * call this immediately before their own save.
   */
  preserveCoManagedStats(sessionId) {
    const id = String(sessionId || '')
    const item = this.coManagedItem(id)
    const executor = id ? this.data.executors[id] : null
    if (!item || !executor || executor.kind !== 'co-managed') return false
    const stats = normalizeExecutorStats(executor)
    item.stats = {
      ...(item.stats && typeof item.stats === 'object' && !Array.isArray(item.stats) ? item.stats : {}),
      ...stats,
    }
    return true
  }

  /**
   * Merge one patch into coManagement[].stats. This is the write-back path for
   * completion tagging and the one-off backfill; unknown relay counters in the
   * same stats object are preserved.
   */
  patchCoManagedStats(sessionId, patch = {}, { save = true } = {}) {
    const item = this.coManagedItem(sessionId)
    if (!item) return null
    const current = normalizeExecutorStats(item.stats)
    const next = normalizeExecutorStats({ ...current, ...(patch || {}) })
    item.stats = {
      ...(item.stats && typeof item.stats === 'object' && !Array.isArray(item.stats) ? item.stats : {}),
      ...next,
    }
    if (save) this.save()
    return next
  }

  syncCoManagedExecutors() {
    const previousCo = Object.fromEntries(Object.entries(this.data.executors || {}).filter(([, executor]) => executor && executor.kind === 'co-managed'))
    const managed = Object.fromEntries(Object.entries(this.data.executors || {}).filter(([, executor]) => executor && executor.kind !== 'co-managed'))
    const co = Array.isArray(this.data.coManagement) ? this.data.coManagement : []
    for (const item of co) {
      const sessionId = String(item && item.sessionId ? item.sessionId : '')
      if (!sessionId) continue
      // coManagement[].stats is the durable source of truth. The in-memory
      // executor record is only a one-time legacy fallback for registrations
      // written before stats existed.
      const prior = this.getCoManagedStats(sessionId) || previousCo[sessionId] || {}
      const label = item.title || item.titleSnapshot || sessionId
      managed[sessionId] = {
        sessionId, kind: 'co-managed', executorType: 'work', scope: 'project', projectCwd: null,
        // No title snapshot here: the board resolves the live Session title in
        // one batch at render time. executorLabel is the role-assigned display
        // fallback (not a live-title cache) and stays for compatibility.
        cwd: item.cwd || null, executorLabel: label,
        tags: Array.isArray(item.tags) ? item.tags.slice() : [],
        roleNote: item.roleNote || '',
        allowAutoDispatch: item.status !== 'inactive' && item.allowDispatch !== false,
        status: item.status === 'inactive' ? 'inactive' : (prior.status && prior.status !== 'inactive' ? prior.status : 'idle'),
        currentTicketId: prior.currentTicketId || null, lastTurnAt: prior.lastTurnAt || null,
        lastTurn: Number.isSafeInteger(prior.lastTurn) && prior.lastTurn >= 0 ? prior.lastTurn : 0,
        addedAt: item.addedAt || null,
        // A co-management sync rebuilds the derived executor entry. Preserve
        // completion-only fields instead of replacing them with empty values.
        autoTags: normalizeAutoTags(prior.autoTags),
        autoTaggedTicketIds: Array.isArray(prior.autoTaggedTicketIds) ? prior.autoTaggedTicketIds.slice() : [],
        lastUsedAt: Number.isFinite(prior.lastUsedAt) ? prior.lastUsedAt : null,
        recentTopics: Array.isArray(prior.recentTopics) ? prior.recentTopics.slice() : [],
      }
    }
    this.data.executors = managed
    // After a rebuild, migrate any stats that only existed on the legacy
    // in-memory record into coManagement[].stats. The caller's save persists it.
    for (const item of co) {
      const id = String(item && item.sessionId ? item.sessionId : '')
      if (id) this.preserveCoManagedStats(id)
    }
  }

  controlOutput() {
    const output = { ...this.data }
    if (Array.isArray(this.data.coManagement)) {
      output.executors = Object.fromEntries(Object.entries(this.data.executors || {}).filter(([, executor]) => executor && executor.kind !== 'co-managed'))
    }
    for (const key of ['requests', 'reports', 'workOrders', 'inbox', 'ticketFeedback', 'lessonCandidates']) delete output[key]
    if (this.metaAuthority === 'sqlite') { delete output.tickets; delete output.ticketMirror }
    return output
  }

  migrateEvents() {
    const keys = ['requests', 'reports', 'workOrders', 'inbox', 'ticketFeedback', 'lessonCandidates']
    if (!this.hasLegacyEvents) return
    try { copyFileSync(this.path, this.path + '.bak.' + new Date().toISOString().replace(/[:.]/g, '-')) } catch (error) { this.warn('state.json backup failed: ' + String(error && error.message ? error.message : error)) }
    const at = Date.now()
    for (const [id, item] of Object.entries(this.data.requests || {})) this.appendEvent('request.created', id, { ...item, migratedAt: at })
    for (const [id, item] of Object.entries(this.data.workOrders || {})) this.appendEvent('workorder.created', id, { ...item, migratedAt: at })
    for (const item of this.data.reports || []) this.appendEvent('report.created', item.ticketId, { ...item, migratedAt: at })
    for (const item of this.data.inbox || []) this.appendEvent('inbox.created', item.ticketId, { ...item, migratedAt: at })
    for (const item of this.data.ticketFeedback || []) this.appendEvent('feedback.created', item.ticketId, { ...item, migratedAt: at })
    for (const key of keys) delete this.data[key]
    this.data.requests = {}
    this.data.reports = []
    this.data.workOrders = {}
    this.data.inbox = []
    this.data.ticketFeedback = []
    this.hasLegacyEvents = false
    this.writeControlState(this.controlOutput())
  }

  rebuildEvents() {
    if (!this.eventLog.hasEvents()) { this.captureSnapshot(); return }
    const { data, badLines, read } = this.eventLog.rebuild(EVENT_LIMITS)
    Object.assign(this.data, data)
    if (hasLegacyKeys(this.data)) {
      this.warnLegacyOnce('events', 'events.jsonl uses legacy ' + LEGACY_KEYWORD + '* payload keys; reading them as executor* (TODO: remove after the next release)')
      Object.assign(this.data, renameLegacyKeys(this.data))
    }
    this.captureSnapshot()
    if (badLines) this.warn('events.jsonl skipped ' + badLines + ' bad line(s) while reading ' + read + ' event(s)')
  }

  load() {
    try {
      if (!existsSync(this.path)) return
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      if (hasLegacyKeys(parsed)) {
        this.warnLegacyOnce('state', 'state.json uses legacy ' + LEGACY_KEYWORD + '* keys; reading them as executor* (TODO: remove after the next release)')
      }
      this.data = { ...EMPTY(), ...renameLegacyKeys(parsed) }
      this.migrateDedicatedFields()
      if (Array.isArray(this.data.coManagement)) this.syncCoManagedExecutors()
      this.hasLegacyEvents = ['requests', 'reports', 'workOrders', 'inbox', 'ticketFeedback', 'lessonCandidates'].some(key => Object.hasOwn(parsed, key))
      const legacyRemoved = LEGACY_STATE_KEYS.filter(key => Object.hasOwn(this.data, key))
      if (legacyRemoved.length) {
        for (const key of legacyRemoved) delete this.data[key]
        this.appendEvent('state.legacy_keys.removed', null, { keys: legacyRemoved })
        this.save()
      }
      if (this.metaAuthority === 'sqlite') {
        // Legacy mirrors are ignored; DB tickets.meta is authoritative.
        delete this.data.tickets
        delete this.data.ticketMirror
      }
      // Stateless Advisor: old "advisors"/"thinkers" bindings are ignored and
      // removed. sagePromptText is likewise deleted; Sage always uses the code
      // prompt. Both disappear on the next save.
      delete this.data.advisors
      delete this.data.thinkers
      delete this.data.sagePromptText
      if (this.data.sageSessionId !== null && typeof this.data.sageSessionId !== 'string') this.data.sageSessionId = null
      for (const key of ['executors', 'requests', 'tickets', 'workOrders']) {
        if (this.metaAuthority === 'sqlite' && key === 'tickets') continue
        if (!this.data[key] || typeof this.data[key] !== 'object' || Array.isArray(this.data[key])) this.data[key] = {}
      }
      if (!this.data.meta || typeof this.data.meta !== 'object' || Array.isArray(this.data.meta)) this.data.meta = { executorSeq: 0, reflectionSeq: 0 }
      this.data.meta.executorSeq = Number.isSafeInteger(this.data.meta.executorSeq) && this.data.meta.executorSeq >= 0 ? this.data.meta.executorSeq : 0
      this.data.meta.reflectionSeq = Number.isSafeInteger(this.data.meta.reflectionSeq) && this.data.meta.reflectionSeq >= 0 ? this.data.meta.reflectionSeq : 0
      let executorFloor = 0
      let reflectionFloor = 0
      for (const executor of Object.values(this.data.executors)) {
        if (!executor || typeof executor !== 'object') continue
        if (Number.isSafeInteger(executor.seq) && executor.seq > 0) {
          if (executor.executorType === 'reflection') reflectionFloor = Math.max(reflectionFloor, executor.seq)
          else executorFloor = Math.max(executorFloor, executor.seq)
        } else if (executor.executorType === 'reflection') reflectionFloor += 1
        else executorFloor += 1
      }
      this.data.meta.executorSeq = Math.max(this.data.meta.executorSeq, executorFloor)
      this.data.meta.reflectionSeq = Math.max(this.data.meta.reflectionSeq, reflectionFloor)
      if (!Array.isArray(this.data.reports)) this.data.reports = []
      if (!Array.isArray(this.data.inbox)) this.data.inbox = []
      delete this.data.lessonCandidates
      if (this.data.lastError !== null && (typeof this.data.lastError !== 'object' || Array.isArray(this.data.lastError))) {
        this.data.lastError = null
      }
      // Ticket metadata written before the rename still says phase "thinker".
      for (const meta of Object.values(this.data.tickets || {})) {
        if (meta && typeof meta === 'object' && meta.phase === 'thinker') meta.phase = 'advisor'
      }
    } catch {
      // A damaged sidecar must not prevent the plugin from starting. Tickets are
      // still recoverable from ria.json; the next write replaces this file.
      this.data = EMPTY()
    }
  }

  /**
   * One-shot idempotent removal of the retired dedicated switch. The field is
   * deleted from both executor and co-management records; only true records
   * produce a migration event, and a second load cannot produce another one.
   */
  migrateDedicatedFields() {
    const sessions = new Set()
    const sources = { executors: [], coManagement: [] }
    let changed = false
    for (const [id, item] of Object.entries(this.data.executors || {})) {
      if (!item || typeof item !== 'object' || !Object.hasOwn(item, 'dedicated')) continue
      if (item.dedicated === true) { sessions.add(String(id)); sources.executors.push(String(id)) }
      delete item.dedicated
      changed = true
    }
    for (const item of Array.isArray(this.data.coManagement) ? this.data.coManagement : []) {
      if (!item || typeof item !== 'object' || !Object.hasOwn(item, 'dedicated')) continue
      if (item.dedicated === true) { sessions.add(String(item.sessionId || '')); sources.coManagement.push(String(item.sessionId || '')) }
      delete item.dedicated
      changed = true
    }
    if (!changed) return 0
    this.save()
    if (sessions.size) {
      this.appendEvent('executor.dedicated.migrated', null, {
        sessions: [...sessions].filter(Boolean).sort(),
        sources: { executors: [...new Set(sources.executors)].sort(), coManagement: [...new Set(sources.coManagement)].sort() },
        at: Date.now(),
      })
    }
    return sessions.size
  }

  /** Copy the RiaStore-owned control fields into this control-plane store. */
  syncRiaControl(store) {
    if (!store) return
    try {
      const settings = store.settings ? store.settings() : store.data && store.data.settings
      if (settings && typeof settings === 'object') this.data.settings = JSON.parse(JSON.stringify(settings))
      const grants = store.grants ? store.grants() : store.data && store.data.grants
      if (Array.isArray(grants)) this.data.grants = JSON.parse(JSON.stringify(grants))
      const recent = store.recentExecutors ? store.recentExecutors() : store.data && store.data.recentExecutors
      if (recent && typeof recent === 'object' && !Array.isArray(recent)) this.data.recentExecutors = JSON.parse(JSON.stringify(recent))
      const preset = store.riaPreset !== undefined ? store.riaPreset : store.data && store.data.riaPreset
      if (typeof preset === 'string' && preset) this.data.riaPreset = preset
      else if (preset === undefined) delete this.data.riaPreset
      const createdAt = store.data && store.data.createdAt
      if (Number.isFinite(createdAt) && createdAt > 0) this.data.createdAt = createdAt
      const lastHuman = typeof store.lastHumanMessageAt === 'number' ? store.lastHumanMessageAt : (store.data && store.data.lastHumanMessageAt)
      if (Number.isFinite(lastHuman) && lastHuman >= 0) this.data.lastHumanMessageAt = lastHuman
    } catch { /* control sync is best effort; the next state write retries */ }
  }

  save() {
    // In SQLite mode the runtime is the writer. Never write state.json from
    // load(); the owner attaches sqliteRuntime before the first commit/mirror.
    if (this.metaAuthority === 'sqlite' && !this.sqliteRuntime) {
      this.pendingSave = true
      return
    }
    if (this.eventLog) {
      const next = this.eventSnapshot()
      this.appendChanges(this.lastSnapshot || next, next)
      this.lastSnapshot = next
      this.writeControlState(this.controlOutput())
      return
    }
    if (this.sqliteRuntime) {
      this.sqliteRuntime.stageStateSave()
      const output = this.controlOutput()
      this.sqliteRuntime.afterCommit(() => this.writeControlState(output), 'control.state')
      return
    }
    const output = { ...this.data }
    if (Array.isArray(this.data.coManagement)) {
      output.executors = Object.fromEntries(Object.entries(this.data.executors || {}).filter(([, executor]) => executor && executor.kind !== 'co-managed'))
    }
    if (this.metaAuthority === 'sqlite') { delete output.tickets; delete output.ticketMirror }
    writeAtomic(this.path, JSON.stringify(output, null, 2))
  }

  /** Session id of the Chat role (the session titled 'Ria'). */
  get chatSessionId() {
    return this.data.chatSessionId || null
  }

  setChat(sessionId) {
    this.data.chatSessionId = String(sessionId)
    this.save()
  }

  get sageSessionId() {
    return this.data.sageSessionId || null
  }

  setSage(sessionId) {
    this.data.sageSessionId = String(sessionId)
    this.save()
  }

  clearSage(sessionId) {
    if (this.data.sageSessionId === String(sessionId)) {
      this.data.sageSessionId = null
      this.save()
    }
  }

  /**
   * Persist the last role/startup failure so a restart can explain why the
   * Chat is missing instead of silently sending inbound messages to a
   * half-installed session. The stack is kept because the controller's logger
   * is not guaranteed to reach the web log.
   */
  recordError(scope, error, extra = {}) {
    const value = error && typeof error === 'object' ? error : { message: String(error) }
    this.data.lastError = {
      scope: String(scope),
      message: String(value.message || value),
      stack: value.stack ? String(value.stack) : null,
      at: Date.now(),
      ...extra,
    }
    this.save()
    return this.data.lastError
  }

  clearError(scope) {
    if (!this.data.lastError) return
    // Errors persisted before the role rename carry scope 'chat'.
    if (scope && String(this.data.lastError.scope) !== String(scope)) return
    this.data.lastError = null
    this.save()
  }

  clearChat(sessionId) {
    if (this.data.chatSessionId === String(sessionId)) {
      this.data.chatSessionId = null
      this.save()
    }
  }



  /**
   * Older records have no executorType; every one of them is a normal work
   * Executor, so the default is applied on read and persisted with the next save.
   */
  normalizeExecutor(item) {
    if (!item || typeof item !== 'object') return item
    normalizeLegacyRecord(item, () => this.warnLegacyOnce('record', 'executor record uses legacy ' + LEGACY_KEYWORD + '* keys; reading them as executor* (TODO: remove after the next release)'))
    if (item.executorType !== 'reflection') item.executorType = 'work'
    // Old bindings remain eligible; only an explicit false opts out.
    item.allowAutoDispatch = item.allowAutoDispatch !== false
    // Executor identity: explicit capability tags, a one-line role note and the
    // soft auto-learned fields. Every read normalizes them so a hand-edited
    // state.json cannot smuggle bad values into routing.
    item.tags = normalizeTags(item.tags, TAG_LIMIT)
    item.autoTags = normalizeAutoTags(item.autoTags)
    item.lastTurn = Number.isSafeInteger(item.lastTurn) && item.lastTurn >= 0 ? item.lastTurn : 0
    // Completion ledger: once a ticket has contributed its tags, replaying the
    // same done settlement must not add them again.
    item.autoTaggedTicketIds = Array.isArray(item.autoTaggedTicketIds)
      ? [...new Set(item.autoTaggedTicketIds.filter(value => typeof value === 'string' && value))].slice(-AUTO_TAG_LEDGER_LIMIT)
      : []
    item.lastUsedAt = Number.isFinite(item.lastUsedAt) ? item.lastUsedAt : null
    item.roleNote = typeof item.roleNote === 'string' ? [...item.roleNote].slice(0, 120).join('') : ''
    delete item.dedicated
    // Display name independent of the host Session title: co-managed Sessions
    // keep their own title, and a managed Executor's label is its assigned
    // "Ria Executor NN". Missing on legacy records; readers fall back.
    if (typeof item.executorLabel === 'string' && item.executorLabel.trim()) item.executorLabel = item.executorLabel.trim()
    else delete item.executorLabel
    item.recentTopics = Array.isArray(item.recentTopics)
      ? item.recentTopics.filter(value => typeof value === 'string' && value).slice(0, 5)
      : []
    return item
  }

  executor(sessionId) {
    return this.normalizeExecutor(this.data.executors[String(sessionId)] || null)
  }

  addExecutor(sessionId, patch = {}, { trigger = 'executor.update' } = {}) {
    const id = String(sessionId)
    patch = renameLegacyKeys(patch || {})
    const previous = this.data.executors[id]
    const before = previous ? { status: previous.status, currentTicketId: previous.currentTicketId || null } : null
    this.data.executors[id] = {
      sessionId: id,
      kind: 'managed',
      executorType: 'work',
      allowAutoDispatch: true,
      scope: 'global',
      status: 'idle',
      currentTicketId: null,
      createdAt: Date.now(),
      ...(this.data.executors[id] || {}),
      ...patch,
    }
    this.normalizeExecutor(this.data.executors[id])
    // Co-managed records are filtered out of state.json, so mirror their
    // completion stats into coManagement[].stats before this save.
    this.preserveCoManagedStats(id)
    this.save()
    const after = { status: this.data.executors[id].status, currentTicketId: this.data.executors[id].currentTicketId || null }
    if (!before || before.status !== after.status || before.currentTicketId !== after.currentTicketId) {
      // Emit after the durable write. Observability cannot invalidate a committed
      // state update, and unchanged metadata writes must not duplicate events.
      try {
        const notify = () => this.onExecutorStateChanged?.({ executorId: id, before, after, trigger })
        if (this.sqliteRuntime) this.sqliteRuntime.afterCommit(notify)
        else notify()
      } catch { /* state is already committed */ }
    }
    return this.data.executors[id]
  }

  executors() {
    return Object.values(this.data.executors).map(item => this.normalizeExecutor(item))
  }

  /**
   * Batch-write executor display labels in one state save. Only the label
   * changes; status, seq and routing fields are left untouched. Used by the
   * title-derived label sync and the one-off alignment script.
   */
  setExecutorLabels(labels = {}) {
    let changed = 0
    for (const [sessionId, title] of Object.entries(labels || {})) {
      const executor = this.data.executors[String(sessionId)]
      if (!executor) continue
      const label = typeof title === 'string' ? title.trim() : ''
      if (!label || executor.executorLabel === label) continue
      executor.executorLabel = label
      changed += 1
    }
    if (changed) this.save()
    return changed
  }

  nextExecutorSeq() {
    if (!this.data.meta) this.data.meta = { executorSeq: 0, reflectionSeq: 0 }
    this.data.meta.executorSeq = (Number.isSafeInteger(this.data.meta.executorSeq) ? this.data.meta.executorSeq : 0) + 1
    this.save()
    return this.data.meta.executorSeq
  }

  nextReflectionSeq() {
    if (!this.data.meta) this.data.meta = { executorSeq: 0, reflectionSeq: 0 }
    this.data.meta.reflectionSeq = (Number.isSafeInteger(this.data.meta.reflectionSeq) ? this.data.meta.reflectionSeq : 0) + 1
    this.save()
    return this.data.meta.reflectionSeq
  }

  /** Persist one-off migration markers next to the role counters. */
  setMeta(patch = {}) {
    if (!this.data.meta || typeof this.data.meta !== 'object') this.data.meta = { executorSeq: 0, reflectionSeq: 0 }
    Object.assign(this.data.meta, patch || {})
    this.save()
    return this.data.meta
  }

  removeExecutor(sessionId) {
    const id = String(sessionId)
    // A physical delete must never take completion stats with it: copy them
    // back to the coManagement registration first, then remove the binding.
    this.preserveCoManagedStats(id)
    delete this.data.executors[id]
    this.save()
  }

  ticketMeta(ticketId) {
    const id = String(ticketId)
    // SQLite is the authority; the in-memory map is only a legacy/JSON cache.
    if (this.sqliteRuntime) {
      const draft = this.sqliteRuntime.currentDraft?.()
      const inDraft = draft?.v2Data?.tickets?.[id]
      if (inDraft) return inDraft
      const record = this.sqliteRuntime.adapter.record(id)
      if (record && record.meta) return record.meta
    }
    // Reading a legacy ticket must not enroll it in state startup recovery.
    // Only setTicketMeta() creates a durable entry.
    return this.normalizeTicketMeta(this.data.tickets?.[id]) || { ticketId: id, scope: 'global', projectId: null }
  }

  /** One-version read compatibility for ticket meta written before the rename. */
  normalizeTicketMeta(meta) {
    if (!meta || typeof meta !== 'object' || !hasLegacyKeys(meta)) return meta
    this.warnLegacyOnce('ticket-meta', 'ticket meta uses legacy ' + LEGACY_KEYWORD + '* keys; reading them as executor* (TODO: remove after the next release)')
    return renameLegacyKeys(meta)
  }

  setTicketMeta(ticketId, patch) {
    const id = String(ticketId)
    if (!this.data.tickets[id]) {
      this.data.tickets[id] = { ticketId: id, scope: 'global', projectId: null, createdAt: Date.now() }
    }
    const meta = this.data.tickets[id]
    Object.assign(meta, renameLegacyKeys(patch || {}), { updatedAt: Date.now() })
    this.save()
    return meta
  }

  ticketMetas() {
    if (this.sqliteRuntime) {
      return this.sqliteRuntime.adapter.records({ includeArchived: true })
        .map(record => this.normalizeTicketMeta(record.meta)).filter(Boolean)
    }
    return Object.values(this.data.tickets).map(meta => this.normalizeTicketMeta(meta))
  }

  addRequest(request) {
    const normalized = renameLegacyKeys(request)
    this.data.requests[normalized.requestId] = clone(normalized)
    this.save()
    return this.data.requests[normalized.requestId]
  }

  request(requestId) {
    return this.data.requests[String(requestId)] || null
  }

  setWorkOrder(ticketId, workOrder) {
    this.data.workOrders[String(ticketId)] = clone(renameLegacyKeys(workOrder))
    this.save()
    return this.data.workOrders[String(ticketId)]
  }

  workOrder(ticketId) {
    return this.data.workOrders[String(ticketId)] || null
  }

  addReport(report) {
    this.data.reports.push(clone(renameLegacyKeys(report)))
    if (this.data.reports.length > 2000) this.data.reports.splice(0, this.data.reports.length - 2000)
    this.save()
    return report
  }

  reportsFor(ticketId, limit = 20) {
    const id = String(ticketId)
    return this.data.reports.filter(item => String(item.ticketId) === id).slice(-limit)
  }

  addInbox(entry) {
    this.data.inbox.push(clone(renameLegacyKeys(entry)))
    if (this.data.inbox.length > 2000) this.data.inbox.splice(0, this.data.inbox.length - 2000)
    this.save()
    return entry
  }

  pendingInbox(ticketId, executorId) {
    const id = String(ticketId)
    const executor = String(executorId)
    return this.data.inbox.filter(item => String(item.ticketId) === id && String(item.executorId || '') === executor && !item.deliveredAt && !item.discardedAt)
  }

  /**
   * Discard every undelivered steering item for one ticket. The entries are
   * kept (with discardedAt/reason) instead of deleted so the audit trail still
   * answers "was anything queued when the ticket was stopped?". pendingInbox
   * filters them out, so a stopped ticket can never receive a late steer.
   */
  discardInboxForTicket(ticketId, { reason = 'ticket cancelled', by = '', at = Date.now() } = {}) {
    const id = String(ticketId)
    let changed = 0
    for (const item of this.data.inbox) {
      if (String(item.ticketId) !== id || item.deliveredAt || item.discardedAt) continue
      item.discardedAt = at
      item.discardedReason = String(reason)
      if (by) item.discardedBy = String(by)
      changed += 1
    }
    if (changed) this.save()
    return changed
  }

  /** Persist a soft-stop request so the executor's next pre-step can end it. */
  requestExecutorStop(sessionId, stop = {}) {
    const id = String(sessionId)
    const executor = this.data.executors[id]
    if (!executor) return null
    executor.stopRequest = {
      ticketId: String(stop.ticketId || ''),
      reason: String(stop.reason || ''),
      at: Number.isFinite(stop.at) ? stop.at : Date.now(),
      hardAbort: Boolean(stop.hardAbort),
      noticedAt: null,
    }
    this.save()
    return executor.stopRequest
  }

  executorStop(sessionId) {
    const executor = this.data.executors[String(sessionId)]
    return executor && executor.stopRequest ? executor.stopRequest : null
  }

  markExecutorStopNoticed(sessionId, at = Date.now()) {
    const executor = this.data.executors[String(sessionId)]
    if (!executor || !executor.stopRequest) return null
    executor.stopRequest.noticedAt = at
    this.save()
    return executor.stopRequest
  }

  clearExecutorStop(sessionId) {
    const executor = this.data.executors[String(sessionId)]
    if (!executor || !executor.stopRequest) return false
    delete executor.stopRequest
    this.save()
    return true
  }

  markInboxDelivered(ids, at = Date.now(), delivery = {}) {
    const set = new Set((ids || []).map(String))
    let changed = false
    for (const item of this.data.inbox) {
      if (set.has(String(item.id)) && !item.deliveredAt) {
        item.deliveredAt = at
        Object.assign(item, delivery)
        changed = true
      }
    }
    if (changed) this.save()
  }
}
