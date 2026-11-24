import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('/* board-tabs:start */')
const end = source.indexOf('/* board-tabs:end */')
assert.ok(start >= 0 && end > start, 'client board-tabs markers')
const block = source.slice(start, end)
const api = new Function(block + '\nreturn { BOARD_TAB_KEY, BOARD_TABS, BOARD_COGNITION_PAGE_SIZE, BOARD_COGNITION_STATUS, isBoardTab, boardTabFromStorage, rememberBoardTab, nextBoardTab, cognitionQuery, cognitionEntryView, cognitionProposalView };')()

const { BOARD_TAB_KEY, BOARD_TABS, BOARD_COGNITION_PAGE_SIZE, BOARD_COGNITION_STATUS, isBoardTab, boardTabFromStorage, rememberBoardTab, nextBoardTab, cognitionQuery, cognitionEntryView, cognitionProposalView } = api

assert.equal(BOARD_TAB_KEY, 'dsh.ria.board.tab.v1')
assert.deepEqual(BOARD_TABS.map(tab => tab.id), ['tickets', 'cognition', 'executors'])
assert.deepEqual(BOARD_TABS.map(tab => tab.label), ['工单', '认知', '执行者'])
assert.equal(BOARD_COGNITION_PAGE_SIZE, 20)
assert.deepEqual(BOARD_COGNITION_STATUS.entries, ['active', 'disputed', 'retired'])
assert.deepEqual(BOARD_COGNITION_STATUS.proposals, ['pending', 'accepted', 'rejected', 'deferred', 'merged'])

assert.equal(isBoardTab('tickets'), true)
assert.equal(isBoardTab('executors'), true)
assert.equal(isBoardTab('bogus'), false)
assert.equal(isBoardTab(null), false)

function makeStorage(initial) {
  const map = new Map(Object.entries(initial || {}))
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null },
    setItem(key, value) { map.set(key, String(value)) },
    dump() { return Object.fromEntries(map) }
  }
}
const empty = makeStorage()
assert.equal(boardTabFromStorage(empty), 'tickets')
assert.equal(boardTabFromStorage(makeStorage({ [BOARD_TAB_KEY]: 'cognition' })), 'cognition')
assert.equal(boardTabFromStorage(makeStorage({ [BOARD_TAB_KEY]: 'executors' })), 'executors')
assert.equal(boardTabFromStorage(makeStorage({ [BOARD_TAB_KEY]: 'garbage' })), 'tickets')
assert.equal(boardTabFromStorage({ getItem() { throw new Error('blocked') } }), 'tickets')
assert.equal(boardTabFromStorage(null), 'tickets')

const remembered = makeStorage()
assert.equal(rememberBoardTab(remembered, 'cognition'), true)
assert.equal(remembered.getItem(BOARD_TAB_KEY), 'cognition')
assert.equal(rememberBoardTab(remembered, 'garbage'), false)
assert.equal(remembered.getItem(BOARD_TAB_KEY), 'cognition')
assert.equal(rememberBoardTab({ setItem() { throw new Error('blocked') } }, 'tickets'), false)
assert.equal(rememberBoardTab(null, 'tickets'), false)

// Arrow navigation wraps in both directions; Home/End are handled in source.
assert.equal(nextBoardTab('tickets', 1), 'cognition')
assert.equal(nextBoardTab('cognition', 1), 'executors')
assert.equal(nextBoardTab('executors', 1), 'tickets')
assert.equal(nextBoardTab('tickets', -1), 'executors')
assert.equal(nextBoardTab('unknown', 1), 'cognition')

const q0 = cognitionQuery('entries', { limit: 20, offset: 0 })
assert.equal(q0, '/cognition/entries?limit=20&offset=0')
const q1 = cognitionQuery('proposals', { scope: 'project:dsh-ria', status: 'pending', q: 'a b', limit: 5, offset: 10 })
assert.ok(q1.startsWith('/cognition/proposals?limit=5&offset=10&'))
assert.ok(q1.includes('scope=project%3Adsh-ria'))
assert.ok(q1.includes('status=pending'))
assert.ok(q1.includes('q=a%20b'))
assert.equal(cognitionQuery('unknown-kind', { limit: 1, offset: 0 }), '/cognition/entries?limit=1&offset=0')

const longBody = 'x'.repeat(400)
const entry = cognitionEntryView({ id: 'cog_1', scope: 'global', body: longBody, status: 'active', updatedAt: 123 })
assert.equal(entry.id, 'cog_1')
assert.equal(entry.scope, 'global')
assert.equal(entry.status, 'active')
assert.equal(entry.updatedAt, 123)
assert.ok(Array.from(entry.body).length <= 180)
assert.ok(entry.body.endsWith('…'))

const proposal = cognitionProposalView({ id: 'prop_1', scope: 'global', body: 'title line\nbody text', status: 'accepted', rationale: 'because', createdAt: 456 })
assert.equal(proposal.title, 'title line')
assert.equal(proposal.status, 'accepted')
assert.equal(proposal.rationale, 'because')
assert.equal(proposal.createdAt, 456)
assert.equal(cognitionProposalView({ id: 'prop_2', body: 'only title' }).rationale, '—')
assert.equal(cognitionProposalView({ id: 'prop_3', body: '   ' }).title, 'prop_3')

// The three-tab shell and both new panels are present, the old modal is gone.
assert.match(source, /data-ria-board-tabs/)
assert.match(source, /role: "tablist"/)
assert.match(source, /"data-ria-board-tab": tab\.id/)
assert.match(source, /"aria-selected": active/)
assert.match(source, /"aria-controls": "ria-board-panel-" \+ tab\.id/)
assert.match(source, /tabIndex: active \? 0 : -1/)
assert.match(source, /onKeyDown: onBoardTabKey/)
assert.match(source, /ArrowRight/)
assert.match(source, /ArrowLeft/)
assert.match(source, /event\.key === "Home"/)
assert.match(source, /event\.key === "End"/)
assert.match(source, /"data-ria-board-panel": "cognition"/)
assert.match(source, /"data-ria-board-panel": "executors"/)
assert.match(source, /"data-ria-cognition-state": "loading"/)
assert.match(source, /"data-ria-cognition-state": "empty"/)
assert.match(source, /"data-ria-cognition-state": "error"/)
assert.match(source, /"data-ria-cognition-more": "1"/)
assert.match(source, /"data-ria-cognition-filter": name/)
assert.match(source, /"data-ria-cognition-search": "1"/)
assert.match(source, /"data-ria-executor-excluded-reason": row\.sessionId/)
assert.match(source, /不可选（未说明原因）/)
assert.match(source, /"data-ria-executors-state": "error"/)
assert.match(source, /"data-ria-executors-state": "empty"/)
assert.doesNotMatch(source, /data-ria-board-executors/)
assert.doesNotMatch(source, /data-ria-executors-overlay/)
assert.doesNotMatch(source, /closeExecutors/)
assert.doesNotMatch(source, /executorsOpen/)

console.log('board tabs ok')
