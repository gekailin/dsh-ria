import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({
  state: true,
  // The workspace registry is the durable archive authority; one managed
  // executor is archived there and must be reported as archived.
  archivedSessionIds: ['session-managed-1'],
  extraSessions: [
    { sessionId: 'session-probe-cm', running: false, blank: false, updatedAt: 10, cwd: '/work/proj', projections: { values: { title: 'Probe CM' } } },
  ],
})
try {
  const service = fixture.service
  const controller = service.controller
  const state = controller.state
  await service.ensure()
  const chat = state.chatSessionId

  // One co-managed executor with empty tags + four managed candidates with a
  // matching tag. The co-managed one must be rejected by the tag rule under the
  // active ticket context.
  const added = await fixture.callAs(chat, 'ria_chat_co_manage', {
    action: 'add', sessionId: 'session-probe-cm', cwd: '/work/proj', tags: [], allowDispatch: true,
  })
  assert.equal(added.ok, true, JSON.stringify(added))
  for (let index = 0; index < 4; index += 1) {
    state.addExecutor('session-managed-' + index, {
      kind: 'managed', scope: 'global', cwd: '/work/proj', status: 'idle',
      allowAutoDispatch: true, tags: [], autoTags: ['probe-tag'], lastUsedAt: Date.now() - index * 1000,
    })
  }
  const ticket = service.store.addTicket({ goal: 'executor diagnostics', status: 'open', waitingOn: 'ria', executor: 'self' })
  state.setTicketMeta(ticket.ticketId, {
    scope: 'global', projectId: null, projectCwd: '/work/proj',
    routingTags: ['probe-tag'], requireTagMatch: true,
  })
  await service.store.save?.()

  // A legacy record may still carry a cached title; live titles win, cache is
  // only the compatibility fallback.
  state.addExecutor('session-legacy-title', {
    kind: 'managed', scope: 'global', cwd: '/work/proj', status: 'idle',
    allowAutoDispatch: true, title: 'Legacy Cached Title', lastUsedAt: Date.now() - 9000,
  })

  // Batch title lookup: one sessionController.list() for the whole page, never
  // one per row. No per-row projections() call either.
  const sc = fixture.service.ctx.sessionController
  const originalList = sc.list.bind(sc)
  const originalProjections = sc.projections.bind(sc)
  let listCalls = 0
  let projectionsCalls = 0
  sc.list = async (...args) => { listCalls += 1; return originalList(...args) }
  sc.projections = async (...args) => { projectionsCalls += 1; return originalProjections(...args) }
  const data = await service.executorDiagnostics({})
  assert.equal(listCalls, 1, 'executor titles are fetched in one batch')
  assert.equal(projectionsCalls, 0, 'no per-row projections call')
  sc.list = originalList
  sc.projections = originalProjections
  assert.equal(data.ok, true)
  assert.equal(data.context.ticketId, ticket.ticketId)
  assert.equal(data.context.projectCwd, '/work/proj')
  assert.deepEqual(data.context.ticketTags, ['probe-tag'])
  assert.equal(data.context.requireTagMatch, true)
  assert.equal(data.context.limit, 3)
  assert.equal(Array.isArray(data.rows), true)
  assert.ok(data.rows.length >= 5)

  const required = ['title', 'titleSource', 'titleLive', 'sessionId', 'kind', 'status', 'archived', 'currentTicketId', 'allowAutoDispatch', 'coManagement', 'tags', 'autoTags', 'cwd', 'lastUsedAt', 'lastTurnAt', 'lastActiveAt', 'executorLabel', 'selectable', 'excludedReason']
  for (const row of data.rows) for (const field of required) assert.ok(Object.hasOwn(row, field), row.sessionId + ' missing ' + field)
  const co = data.rows.find(row => row.sessionId === 'session-probe-cm')
  assert.ok(co, 'co-managed row present')
  assert.equal(co.kind, 'co-managed')
  assert.equal(co.title, 'Probe CM')
  assert.equal(co.titleSource, 'session')
  assert.equal(co.archived, false)
  assert.equal(co.coManagement.status, 'active')
  assert.equal(co.coManagement.allowDispatch, true)
  assert.equal(typeof co.coManagement.addedAt, 'number')
  assert.equal(co.coManagement.retiredReason, '')
  const archivedManaged = data.rows.find(row => row.sessionId === 'session-managed-1')
  assert.equal(archivedManaged.archived, true)
  assert.equal(archivedManaged.titleSource, 'sessionId')
  assert.equal(archivedManaged.title, 'session-ma…')
  const legacy = data.rows.find(row => row.sessionId === 'session-legacy-title')
  assert.equal(legacy.title, 'Legacy Cached Title')
  assert.equal(legacy.titleSource, 'cache')
  assert.equal(legacy.titleLive, false)
  assert.equal(data.rows.find(row => row.sessionId === 'session-managed-0').archived, false)
  assert.equal(co.selectable, false)
  assert.match(co.excludedReason, /requireTagMatch: wanted=probe-tag but tags=\[\] autoTags=\[\]/)
  const selectableManaged = data.rows.find(row => row.sessionId === 'session-managed-0')
  assert.equal(selectableManaged.selectable, true)
  assert.equal(selectableManaged.excludedReason, null)

  // Direct-call consistency: row.selectable must match the live helper exactly.
  for (const row of data.rows) {
    const executor = state.executor(row.sessionId)
    let reason = null
    const direct = controller.isExecutorSelectable(executor, {
      ...data.context,
      onReject: value => { reason = value },
    })
    assert.equal(row.selectable, direct, 'selectable mismatch for ' + row.sessionId)
    if (!direct) assert.equal(row.excludedReason, reason, 'reason mismatch for ' + row.sessionId)
  }

  // Untagged project context: co-managed passes filters, but rank > limit is
  // reported by the same rankCandidateExecutors result.
  const untagged = await service.executorDiagnostics({ projectCwd: '/work/proj', tags: '', requireTagMatch: false })
  const untaggedCo = untagged.rows.find(row => row.sessionId === 'session-probe-cm')
  assert.equal(untaggedCo.selectable, true)
  assert.ok(untaggedCo.rank > 3, JSON.stringify(untagged.rows.map(row => ({ id: row.sessionId, selectable: row.selectable, rank: row.rank, reason: row.excludedReason, tags: row.tags, autoTags: row.autoTags }))))
  assert.match(untaggedCo.excludedReason, /^rank \d+\/\d+ \(limit 3\)$/)

  // executing=true must be reported as the selection reason.
  state.setTicketMeta(ticket.ticketId, { executing: true, executorSessionId: 'session-probe-cm' })
  const busy = await service.executorDiagnostics({ projectCwd: '/work/proj', tags: '', requireTagMatch: false })
  const busyCo = busy.rows.find(row => row.sessionId === 'session-probe-cm')
  assert.equal(busyCo.selectable, false)
  assert.match(busyCo.excludedReason, /executing=true/)

  // Real GET endpoint: parse through the registered plugin route.
  async function getJson(path) {
    const route = fixture.routes.find(item => item.path === '/plugins/dsh-ria/api')
    assert.ok(route, 'plugin API route registered')
    const req = new EventEmitter()
    req.method = 'GET'
    req.url = path
    req.headers = { host: '127.0.0.1:3080' }
    const res = new EventEmitter()
    res.statusCode = 0
    res.headers = {}
    res.chunks = []
    res.setHeader = function (name, value) { this.headers[name] = value }
    res.writeHead = function (status, values) { this.statusCode = status; Object.assign(this.headers, values || {}); return this }
    res.end = function (chunk) { if (chunk) this.chunks.push(String(chunk)); this.emit('close'); return this }
    await route.handler(req, res)
    return { status: res.statusCode, body: JSON.parse(res.chunks.join('') || '{}') }
  }
  const http = await getJson('/plugins/dsh-ria/api/executors?projectCwd=%2Fwork%2Fproj&tags=probe-tag&requireTagMatch=true')
  assert.equal(http.status, 200, JSON.stringify(http.body))
  assert.equal(http.body.ok, true)
  assert.equal(http.body.rows.length, data.rows.length)
  assert.ok(http.body.rows.every(row => required.every(field => Object.hasOwn(row, field))))

  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The old title-bar modal became a first-class tab: no overlay/button, but
  // the diagnostics table and its sorting stay.
  assert.match(client, /id: "executors", active: true/)
  assert.match(client, /executorsPanel\(\)/)
  assert.doesNotMatch(client, /data-ria-board-executors/)
  assert.doesNotMatch(client, /data-ria-executors-overlay/)
  assert.match(client, /data-ria-executors-table/)
  assert.match(client, /data-ria-executors-archive-table/)
  assert.match(client, /data-ria-executor-sort/)
  assert.match(client, /data-ria-executor-archive-sort/)
  assert.match(client, /sortExecutorRows\(/)
  assert.match(client, /"data-ria-executors-archive-toggle": "1"/)
  assert.match(client, /"aria-sort": active \?/)
  // Both executor tables gained explicit tags and autoTags columns, sharing
  // the same truncation renderer; empty values use the em dash.
  assert.match(client, /executorPlainHeader\("tags", "tags"\)/)
  assert.match(client, /executorPlainHeader\("autoTags", "autoTags"\)/)
  assert.match(client, /"data-ria-executor-column": key/)
  assert.match(client, /executorTagCell\(row\.tags, false\)/)
  assert.match(client, /executorTagCell\(row\.autoTags, true\)/)
  assert.match(client, /executorTagText\(value, EXECUTOR_TAG_DISPLAY_LIMIT, auto\)/)
  assert.match(client, /"data-ria-executor-tags": auto \? "autoTags" : "tags"/)
  assert.match(client, /" \+" \+ hidden/)
  // Both tables default to the newest activity first; the default column is
  // rendered through executorSortHeader so it shows the sort arrow/aria-sort.
  assert.match(client, /executorSortHeader\("lastUsedAt", "lastUsedAt"/)
  const defaultSorts = client.match(/useState\(\{ key: "lastUsedAt", dir: "desc" \}\)/g) || []
  assert.equal(defaultSorts.length, 2, 'active and archived tables default to lastUsedAt desc')
  assert.doesNotMatch(client, /useState\(\{ key: "status", dir: "asc" \}\)/)
  assert.doesNotMatch(client, /data-ria-executor-excluded-reason/)
  assert.doesNotMatch(client, /executorRows\.sort\(/)
  assert.doesNotMatch(client, /data-ria-executors-context/)
  assert.doesNotMatch(client, /data-ria-co-management/)
  assert.doesNotMatch(client, /coManaged/)
  console.log('board executors ok')
} finally {
  fixture.cleanup()
}