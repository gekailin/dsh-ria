import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({
  state: true,
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

  const data = service.executorDiagnostics({})
  assert.equal(data.ok, true)
  assert.equal(data.context.ticketId, ticket.ticketId)
  assert.equal(data.context.projectCwd, '/work/proj')
  assert.deepEqual(data.context.ticketTags, ['probe-tag'])
  assert.equal(data.context.requireTagMatch, true)
  assert.equal(data.context.limit, 3)
  assert.equal(Array.isArray(data.rows), true)
  assert.ok(data.rows.length >= 5)

  const required = ['title', 'sessionId', 'kind', 'status', 'currentTicketId', 'allowAutoDispatch', 'tags', 'autoTags', 'cwd', 'lastUsedAt', 'lastTurnAt', 'executorLabel', 'selectable', 'excludedReason']
  for (const row of data.rows) for (const field of required) assert.ok(Object.hasOwn(row, field), row.sessionId + ' missing ' + field)
  const co = data.rows.find(row => row.sessionId === 'session-probe-cm')
  assert.ok(co, 'co-managed row present')
  assert.equal(co.kind, 'co-managed')
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
  const untagged = service.executorDiagnostics({ projectCwd: '/work/proj', tags: '', requireTagMatch: false })
  const untaggedCo = untagged.rows.find(row => row.sessionId === 'session-probe-cm')
  assert.equal(untaggedCo.selectable, true)
  assert.ok(untaggedCo.rank > 3, JSON.stringify(untagged.rows.map(row => ({ id: row.sessionId, selectable: row.selectable, rank: row.rank, reason: row.excludedReason, tags: row.tags, autoTags: row.autoTags }))))
  assert.match(untaggedCo.excludedReason, /^rank \d+\/\d+ \(limit 3\)$/)

  // executing=true must be reported as the selection reason.
  state.setTicketMeta('ticket_exec_probe', { executing: true, executorSessionId: 'session-probe-cm' })
  const busy = service.executorDiagnostics({ projectCwd: '/work/proj', tags: '', requireTagMatch: false })
  const busyCo = busy.rows.find(row => row.sessionId === 'session-probe-cm')
  assert.equal(busyCo.selectable, false)
  assert.match(busyCo.excludedReason, /executing=true/)

  // Real GET endpoint: parse through the registered plugin route.
  function getJson(path) {
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
    route.handler(req, res)
    return { status: res.statusCode, body: JSON.parse(res.chunks.join('') || '{}') }
  }
  const http = getJson('/plugins/dsh-ria/api/executors?projectCwd=%2Fwork%2Fproj&tags=probe-tag&requireTagMatch=true')
  assert.equal(http.status, 200, JSON.stringify(http.body))
  assert.equal(http.body.ok, true)
  assert.equal(http.body.rows.length, data.rows.length)
  assert.ok(http.body.rows.every(row => required.every(field => Object.hasOwn(row, field))))

  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /"data-ria-board-executors": "1"/)
  assert.match(client, /"data-ria-executors-overlay": "1"/)
  assert.match(client, /"data-ria-executors-table": "1"/)
  assert.match(client, /"data-ria-executor-sort": key/)
  assert.match(client, /executorRows\.sort\(/)
  assert.match(client, /dir: previous\.key === key && previous\.dir === "asc" \? "desc" : "asc"/)
  assert.match(client, /data-ria-executors-context/)
  assert.doesNotMatch(client, /data-ria-co-management/)
  assert.doesNotMatch(client, /coManaged/)
  console.log('board executors ok')
} finally {
  fixture.cleanup()
}
