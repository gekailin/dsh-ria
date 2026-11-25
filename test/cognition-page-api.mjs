import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createFixture } from './support/ria-fixture.mjs'

const fixture = await createFixture({ stateDefault: true })
const server = createServer((req, res) => fixture.service.httpHandler(req, res))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const api = 'http://127.0.0.1:' + server.address().port + '/plugins/dsh-ria/api'
const get = async path => {
  const response = await fetch(api + path)
  return { status: response.status, body: await response.json() }
}

try {
  const cognition = fixture.service.controller.cognition
  const seeded = [
    ['global', 'active', 'alpha rule about tickets'],
    ['global', 'active', 'beta rule about emoji'],
    ['global', 'disputed', 'gamma disputed rule'],
    ['project:dsh-ria', 'active', 'delta project rule'],
    ['project:dsh-ria', 'retired', 'epsilon retired rule'],
  ]
  for (const [scope, status, body] of seeded) {
    const created = cognition.upsertEntry({
      scope, status, body, cause: 'test cause',
      sources: [{ type: 'file', ref: 'test/support/ria-fixture.mjs' }],
    })
    assert.equal(created.ok, true, JSON.stringify(created))
  }
  const p1 = cognition.propose({ author: 'reflection', source: 'reflection', scope: 'global', body: 'proposal alpha title', cause: 'why alpha' })
  cognition.propose({ author: 'sage', source: 'sage', scope: 'project:dsh-ria', body: 'proposal beta title', cause: 'why beta' })
  const p3 = cognition.propose({ author: 'reflection', source: 'reflection', scope: 'global', body: 'proposal gamma title', cause: 'why gamma' })
  const db = cognition.openDb()
  db.prepare("UPDATE cognition_proposals SET status='accepted', rationale='accepted because tested', decided_by='sage', decided_at=? WHERE id=?").run(Date.now(), p1.id)
  db.prepare("UPDATE cognition_proposals SET status='pending', rationale=NULL WHERE id=?").run(p3.id)

  // Page one: explicit limit/offset, total and hasMore are part of the contract.
  const first = await get('/cognition/entries?limit=2')
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.items.length, 2)
  assert.equal(first.body.total, 5)
  assert.equal(first.body.limit, 2)
  assert.equal(first.body.offset, 0)
  assert.equal(first.body.hasMore, true)
  assert.ok(Array.isArray(first.body.scopes) && first.body.scopes.includes('global'))

  // Omitted limit uses the board page size of 30 on both sides.
  const defaults = await get('/cognition/entries')
  assert.equal(defaults.status, 200)
  assert.equal(defaults.body.limit, 30)
  const proposalDefaults = await get('/cognition/proposals')
  assert.equal(proposalDefaults.status, 200)
  assert.equal(proposalDefaults.body.limit, 30)

  const second = await get('/cognition/entries?limit=2&offset=2')
  assert.equal(second.status, 200)
  assert.equal(second.body.items.length, 2)
  assert.equal(second.body.hasMore, true)
  assert.notEqual(second.body.items[0].id, first.body.items[0].id)
  const third = await get('/cognition/entries?limit=2&offset=4')
  assert.equal(third.status, 200)
  assert.equal(third.body.items.length, 1)
  assert.equal(third.body.hasMore, false)

  // Filters: scope, status, and text search on the body.
  const scoped = await get('/cognition/entries?scope=project%3Adsh-ria&limit=20')
  assert.equal(scoped.status, 200)
  assert.equal(scoped.body.total, 2)
  assert.ok(scoped.body.items.every(row => row.scope === 'project:dsh-ria'))
  const disputed = await get('/cognition/entries?status=disputed&limit=20')
  assert.equal(disputed.status, 200)
  assert.equal(disputed.body.total, 1)
  assert.equal(disputed.body.items[0].status, 'disputed')
  const search = await get('/cognition/entries?q=emoji&limit=20')
  assert.equal(search.status, 200)
  assert.equal(search.body.total, 1)
  assert.match(search.body.items[0].body, /emoji/)

  // Proposals: fields, status filter and title/body search.
  const proposals = await get('/cognition/proposals?limit=2')
  assert.equal(proposals.status, 200)
  assert.equal(proposals.body.total, 3)
  assert.equal(proposals.body.items.length, 2)
  assert.equal(proposals.body.hasMore, true)
  const proposalFields = ['id', 'body', 'status', 'rationale', 'createdAt', 'scope']
  for (const field of proposalFields) assert.ok(Object.hasOwn(proposals.body.items[0], field), 'missing ' + field)
  const accepted = await get('/cognition/proposals?status=accepted&limit=20')
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.total, 1)
  assert.equal(accepted.body.items[0].rationale, 'accepted because tested')
  const proposalSearch = await get('/cognition/proposals?q=beta&limit=20')
  assert.equal(proposalSearch.status, 200)
  assert.equal(proposalSearch.body.total, 1)
  assert.match(proposalSearch.body.items[0].body, /beta/)

  // Invalid input is rejected before the store is queried.
  for (const path of [
    '/cognition/entries?limit=0',
    '/cognition/entries?limit=101',
    '/cognition/entries?limit=abc',
    '/cognition/entries?offset=-1',
    '/cognition/entries?status=bogus',
    '/cognition/entries?scope=not%20a%20scope',
    '/cognition/proposals?status=bogus',
    '/cognition/proposals?limit=0',
  ]) {
    const bad = await get(path)
    assert.equal(bad.status, 400, path + ' -> ' + JSON.stringify(bad.body))
    assert.equal(typeof bad.body.error, 'string')
  }

  // LIKE wildcards in user input are escaped, not treated as patterns.
  const wildcard = cognition.upsertEntry({
    scope: 'global', status: 'active', body: '100% coverage report',
    cause: 'wildcard escaping', sources: [{ type: 'file', ref: 'test/cognition-page-api.mjs' }],
  })
  assert.equal(wildcard.ok, true)
  const escaped = await get('/cognition/entries?q=100%25&limit=20')
  assert.equal(escaped.status, 200)
  assert.equal(escaped.body.total, 1)
  assert.match(escaped.body.items[0].body, /100% coverage/)

  // Query-count guard: one COUNT, one page SELECT and one DISTINCT scope query.
  const realPrepare = db.prepare.bind(db)
  let prepares = 0
  db.prepare = (...args) => { prepares += 1; return realPrepare(...args) }
  try {
    const page = cognition.listEntriesPage({ limit: 2, offset: 0 })
    assert.equal(page.ok, true)
    assert.equal(prepares, 3, 'expected exactly 3 statements, got ' + prepares)
  } finally {
    db.prepare = realPrepare
  }

  // List projections bound free-form proposal text; the board page must not
  // ship a whole multi-KB report body just to render a card preview.
  const longProposal = cognition.propose({ author: 'reflection', source: 'reflection', body: 'detail '.repeat(300), cause: 'because '.repeat(200) })
  db.prepare('UPDATE cognition_proposals SET rationale=? WHERE id=?').run('r'.repeat(800), longProposal.id)
  const bounded = await get('/cognition/proposals?q=detail&limit=100')
  const boundedRow = bounded.body.items.find(item => item.id === longProposal.id)
  assert.ok(boundedRow, 'long proposal is listed')
  assert.ok(boundedRow.body.length <= 600, 'proposal body is bounded in the list')
  assert.ok(boundedRow.cause.length <= 240, 'proposal cause is bounded in the list')
  assert.ok(boundedRow.rationale.length <= 400, 'proposal rationale is bounded in the list')

  const cognitionSource = readFileSync(new URL('../lib/roles/cognition.mjs', import.meta.url), 'utf8')
  assert.ok(!/SELECT \* FROM cognition_entries|SELECT \* FROM cognition_proposals/.test(cognitionSource), 'cognition reads name their columns')

  console.log('cognition page api ok')
} finally {
  await new Promise(resolve => server.close(resolve))
  fixture.cleanup()
}
