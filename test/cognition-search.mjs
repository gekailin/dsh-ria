import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// ria_chat_cognition_search: the Chat-only, strictly read-only escape hatch for
// the truncated prompt digest. This test pins the contract end to end: filters,
// pagination, empty-argument rejection, complete bodies, ordering, role
// isolation and the absence of any write side effect.

const fixture = await createFixture({ stateDefault: true, extraGlobalTools: ['grep', 'glob'] })
const TOOL = 'ria_chat_cognition_search'

try {
  const service = fixture.service
  const controller = service.controller
  const chat = controller.state.chatSessionId
  const cognition = controller.cognition
  const source = { type: 'file', ref: 'docs/spec/cognition.md' }
  const seed = (scope, body, cause) => {
    const result = cognition.upsertEntry({ scope, body, cause, sources: [source] })
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.entry
  }

  const agreement = seed('user:agreement', '部署前必须先确认部署窗口', '用户约定')
  const preference = seed('user:preference', '汇报用中文，先给结论', '用户偏好')
  const projectA = seed('project:dsh-ria-aaaaaaaa', '通知里必须带完整工单号', '拼接时丢失过 id')
  const projectB = seed('project:dsh-ria-bbbbbbbb', '沙箱内不能 fork 常驻进程', 'bwrap die-with-parent')
  const other = seed('project:other-cccccccc', '无关项目认知', '无关')
  const disputed = cognition.upsertEntry({ scope: 'domain:retired-probe', body: '已争议条目', cause: '争议', status: 'disputed', sources: [source] })
  assert.equal(disputed.ok, true, JSON.stringify(disputed))

  const db = cognition.openDb()
  // Deterministic updated_at so ordering assertions cannot depend on wall clock.
  const stamp = (entry, at) => db.prepare('UPDATE cognition_entries SET updated_at=? WHERE id=?').run(at, entry.id)
  stamp(agreement, 1001); stamp(preference, 1002); stamp(projectA, 1003); stamp(projectB, 1004); stamp(other, 1005)
  stamp(disputed.entry, 1006)

  // A body far beyond the 250-char write cap proves the reader never clips.
  const longBody = '长'.repeat(4000) + '-END'
  const now = Date.now()
  db.prepare('INSERT INTO cognition_entries(id,scope,kind,status,tags,body,cause,sources,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('cog_999999', 'domain:long', 'experience', 'active', '[]', longBody, 'long body probe', '[]', 'sage', now, 2000)

  const search = async args => {
    const result = await fixture.callAs(chat, TOOL, args)
    assert.equal(result && typeof result === 'object', true, 'tool returns an object')
    return result
  }

  // 1) query hits body / cause / scope.
  const byBody = await search({ query: '工单号' })
  assert.equal(byBody.ok, true, JSON.stringify(byBody))
  assert.deepEqual(byBody.items.map(item => item.id), [projectA.id])
  assert.equal(byBody.total, 1)
  assert.equal(byBody.truncated, false)

  const byCause = await search({ query: 'die-with-parent' })
  assert.deepEqual(byCause.items.map(item => item.id), [projectB.id])

  const byScopeText = await search({ query: 'dsh-ria' })
  assert.deepEqual(byScopeText.items.map(item => item.id), [projectB.id, projectA.id], 'scope match is case-insensitive and ordered updatedAt DESC')

  // 2) scope filter: exact and prefix.
  const exactScope = await search({ scope: 'user:agreement' })
  assert.deepEqual(exactScope.items.map(item => item.id), [agreement.id])
  assert.equal(exactScope.total, 1)

  const prefixScope = await search({ scope: 'project:dsh-ria' })
  assert.deepEqual(prefixScope.items.map(item => item.id), [projectB.id, projectA.id], 'prefix matches both project:dsh-ria* scopes')
  assert.equal(prefixScope.total, 2)
  assert.equal(prefixScope.items.some(item => item.id === other.id), false, 'a different project scope is not matched')

  // 3) status filter.
  const disputedOnly = await search({ status: 'disputed' })
  assert.deepEqual(disputedOnly.items.map(item => item.id), [disputed.entry.id])
  const activeOnly = await search({ scope: 'project:other-cccccccc', status: 'active' })
  assert.deepEqual(activeOnly.items.map(item => item.id), [other.id])
  const activeWithoutDisputed = await search({ status: 'active', query: '已争议条目' })
  assert.equal(activeWithoutDisputed.total, 0, 'status filter actually filters')

  // 4) limit / offset pagination with total + truncated.
  const pageOne = await search({ scope: 'project:dsh-ria', limit: 1 })
  assert.deepEqual(pageOne.items.map(item => item.id), [projectB.id])
  assert.equal(pageOne.total, 2)
  assert.equal(pageOne.truncated, true, 'more rows remain than the page returned')
  assert.equal(pageOne.limit, 1)
  assert.equal(pageOne.offset, 0)

  const pageTwo = await search({ scope: 'project:dsh-ria', limit: 1, offset: 1 })
  assert.deepEqual(pageTwo.items.map(item => item.id), [projectA.id])
  assert.equal(pageTwo.total, 2)
  assert.equal(pageTwo.truncated, false, 'the last page is not truncated')

  const emptyPage = await search({ scope: 'project:dsh-ria', limit: 1, offset: 2 })
  assert.deepEqual(emptyPage.items, [])
  assert.equal(emptyPage.total, 2)
  assert.equal(emptyPage.truncated, false)

  const capped = await search({ query: '认知', limit: 999 })
  assert.equal(capped.limit, 50, 'limit is capped at 50')

  // 5) empty arguments are rejected and never dump the store.
  const empty = await search({})
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'cognition_query_required')
  assert.equal('items' in empty, false, 'no rows are returned for an empty query')
  const blank = await search({ query: '   ', scope: '  ' })
  assert.equal(blank.code, 'cognition_query_required')

  // 6) complete body, no truncation anywhere in the chain.
  const long = await search({ query: '-END' })
  assert.equal(long.items.length, 1)
  assert.equal(long.items[0].body, longBody, 'body is returned verbatim')
  assert.equal(long.items[0].body.length, longBody.length)
  assert.equal(long.items[0].body.endsWith('…'), false)

  // 7) documented fields are present on every row.
  const fields = await search({ scope: 'user:preference' })
  const row = fields.items[0]
  assert.deepEqual(Object.keys(row).sort(), ['body', 'cause', 'createdAt', 'id', 'scope', 'status', 'supersededBy', 'updatedAt'])
  assert.equal(row.id, preference.id)
  assert.equal(row.scope, 'user:preference')
  assert.equal(row.status, 'active')
  assert.equal(Number.isFinite(row.createdAt) && Number.isFinite(row.updatedAt), true)
  assert.equal(row.supersededBy, null)

  // 8) strictly read-only: repeated searches leave the store untouched.
  const snapshot = () => db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)),0) AS bytes, COALESCE(MAX(updated_at),0) AS latest FROM cognition_entries').get()
  const before = snapshot()
  for (let index = 0; index < 5; index++) {
    await search({ scope: 'project:dsh-ria' })
    await search({ query: '认知' })
    await search({ status: 'active' })
  }
  assert.deepEqual(snapshot(), before, 'searches must not insert, update or delete cognition entries')

  // 9) role isolation: Chat only.
  const chatTools = fixture.visibleTools(chat)
  assert.equal(chatTools.includes(TOOL), true, 'Chat keeps the tool')
  // Executor: dispatch a real ticket and inspect its surface.
  const request = await controller.requestTicket({ goal: '认知检索隔离验证', acceptance: '对比工具面' }, { agent: { id: chat } })
  assert.equal(request.ok, true, JSON.stringify(request))
  const advisor = controller.state.ticketMeta(request.ticketId).advisorSessionId
  assert.equal(controller.roleFor(advisor), 'advisor')
  assert.equal(fixture.visibleTools(advisor).includes(TOOL), false, 'Advisor must not see the tool')
  const plan = await fixture.callAs(advisor, 'ria_ticket_plan', { ticketId: request.ticketId, summary: 'inspect tool surfaces', steps: ['compare'], artifacts: [] })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  const dispatch = await fixture.callAs(advisor, 'ria_ticket_dispatch', { ticketId: request.ticketId })
  assert.equal(dispatch.ok, true, JSON.stringify(dispatch))
  const executorTools = fixture.visibleTools(dispatch.executorSessionId)
  assert.equal(executorTools.includes(TOOL), false, 'Executor must not see the tool')

  // Reflection: an executor kind with a read-only retrospective surface.
  const reflectionRequest = await controller.requestTicket({ goal: '反思工具面核查', acceptance: '对比工具面' }, { agent: { id: chat } }, { mode: 'reflection' })
  assert.equal(reflectionRequest.ok, true, JSON.stringify(reflectionRequest))
  const reflectionAdvisor = controller.state.ticketMeta(reflectionRequest.ticketId).advisorSessionId
  const reflectionPlan = await fixture.callAs(reflectionAdvisor, 'ria_ticket_plan', { ticketId: reflectionRequest.ticketId, summary: 'inspect', steps: ['compare'], artifacts: [] })
  assert.equal(reflectionPlan.ok, true, JSON.stringify(reflectionPlan))
  const reflectionDispatch = await fixture.callAs(reflectionAdvisor, 'ria_ticket_dispatch', { ticketId: reflectionRequest.ticketId })
  assert.equal(reflectionDispatch.ok, true, JSON.stringify(reflectionDispatch))
  const reflectionTools = fixture.visibleTools(reflectionDispatch.executorSessionId)
  assert.ok(reflectionTools.length > 0, 'reflection surface is installed')
  assert.equal(reflectionTools.includes(TOOL), false, 'Reflection must not see the tool')

  console.log('cognition search ok')
} finally {
  fixture.cleanup()
}
