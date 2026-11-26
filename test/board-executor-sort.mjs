import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('/* board-executor-sort:start */')
const end = source.indexOf('/* board-executor-sort:end */')
assert.ok(start >= 0 && end > start, 'executor sort markers')
const block = source.slice(start, end)
const api = new Function(block + '\nreturn { executorLastActive, executorSortValue, nextExecutorSort, sortExecutorRows, splitExecutorRows, executorTagText, EXECUTOR_TAG_DISPLAY_LIMIT, executorAutoTagEntries, executorCurrentTurn, executorAutoTagRows };')()
const { executorLastActive, executorSortValue, nextExecutorSort, sortExecutorRows, splitExecutorRows, executorTagText, EXECUTOR_TAG_DISPLAY_LIMIT, executorAutoTagEntries, executorCurrentTurn, executorAutoTagRows } = api

const rows = [
  { sessionId: 's-3', title: 'Zeta', cwd: '/z', status: 'idle', allowAutoDispatch: true, archived: false, lastUsedAt: 100 },
  { sessionId: 's-1', title: 'Alpha', cwd: '/a', status: 'working', allowAutoDispatch: false, archived: false, lastTurnAt: 300 },
  { sessionId: 's-2', title: 'Beta', cwd: '/b', status: 'idle', allowAutoDispatch: true, archived: true, lastUsedAt: 200 },
  { sessionId: 's-4', title: 'Alpha', cwd: '/c', status: 'idle', allowAutoDispatch: true, archived: false, lastUsedAt: 50 },
]

// Ascending then descending on the same column.
const byTitleAsc = sortExecutorRows(rows, { key: 'title', dir: 'asc' })
assert.deepEqual(byTitleAsc.map(row => row.sessionId), ['s-1', 's-4', 's-2', 's-3'])
const byTitleDesc = sortExecutorRows(rows, { key: 'title', dir: 'desc' })
assert.deepEqual(byTitleDesc.map(row => row.sessionId), ['s-3', 's-2', 's-1', 's-4'])

// Click toggles asc -> desc for the same column, and starts asc elsewhere.
assert.deepEqual(nextExecutorSort({ key: 'title', dir: 'asc' }, 'title'), { key: 'title', dir: 'desc' })
assert.deepEqual(nextExecutorSort({ key: 'title', dir: 'desc' }, 'title'), { key: 'title', dir: 'asc' })
assert.deepEqual(nextExecutorSort({ key: 'title', dir: 'desc' }, 'cwd'), { key: 'cwd', dir: 'asc' })

// Activity uses the newest of lastActiveAt/lastUsedAt/lastTurnAt; missing is last.
assert.equal(executorLastActive({ lastUsedAt: 1, lastTurnAt: 2 }), 2)
assert.equal(executorLastActive({}), null)
const byActivity = sortExecutorRows(rows, { key: 'lastActiveAt', dir: 'desc' })
assert.deepEqual(byActivity.map(row => row.sessionId), ['s-1', 's-2', 's-3', 's-4'])

// Booleans sort false before true ascending.
const byAuto = sortExecutorRows(rows, { key: 'allowAutoDispatch', dir: 'asc' })
assert.equal(byAuto[0].sessionId, 's-1')
assert.equal(executorSortValue({ allowAutoDispatch: false }, 'allowAutoDispatch'), 0)
assert.equal(executorSortValue({ allowAutoDispatch: true }, 'allowAutoDispatch'), 1)

// Sort is stable through the sessionId tiebreak and never mutates the input.
const before = rows.map(row => row.sessionId)
sortExecutorRows(rows, { key: 'title', dir: 'asc' })
assert.deepEqual(rows.map(row => row.sessionId), before)

// Archive split: first table only unarchived, second only archived.
const split = splitExecutorRows(rows)
assert.deepEqual(split.active.map(row => row.sessionId), ['s-3', 's-1', 's-4'])
assert.deepEqual(split.archived.map(row => row.sessionId), ['s-2'])
assert.deepEqual(splitExecutorRows(null), { active: [], archived: [] })

// Default sort key: lastUsedAt desc, with missing/zero/invalid values last.
const usageRows = [
  { sessionId: 'u-b', title: 'B', lastUsedAt: 300 },
  { sessionId: 'u-a', title: 'A', lastUsedAt: 300 },
  { sessionId: 'u-g', title: 'G', lastUsedAt: 100 },
  { sessionId: 'u-null', title: 'N', lastUsedAt: null },
  { sessionId: 'u-missing', title: 'M' },
  { sessionId: 'u-zero', title: 'Z', lastUsedAt: 0 },
  { sessionId: 'u-bad', title: 'X', lastUsedAt: 'not-a-number' },
]
const missingLast = ['u-bad', 'u-missing', 'u-null', 'u-zero']
const byUsageDesc = sortExecutorRows(usageRows, { key: 'lastUsedAt', dir: 'desc' })
assert.deepEqual(byUsageDesc.map(row => row.sessionId), ['u-a', 'u-b', 'u-g', ...missingLast])
const byUsageAsc = sortExecutorRows(usageRows, { key: 'lastUsedAt', dir: 'asc' })
assert.deepEqual(byUsageAsc.map(row => row.sessionId), ['u-g', 'u-a', 'u-b', ...missingLast])
assert.equal(executorSortValue({ lastUsedAt: 0 }, 'lastUsedAt'), null)
assert.equal(executorSortValue({ lastUsedAt: -1 }, 'lastUsedAt'), null)
assert.equal(executorSortValue({ lastUsedAt: 'x' }, 'lastUsedAt'), null)
assert.equal(executorSortValue({ lastUsedAt: 42 }, 'lastUsedAt'), 42)
assert.deepEqual(
  sortExecutorRows([{ sessionId: 'z' }, { sessionId: 'y' }], { key: 'lastUsedAt', dir: 'desc' }).map(row => row.sessionId),
  ['y', 'z'],
  'all-missing rows still get a deterministic sessionId tiebreak',
)
assert.deepEqual(usageRows.map(row => row.sessionId), ['u-b', 'u-a', 'u-g', 'u-null', 'u-missing', 'u-zero', 'u-bad'])
assert.deepEqual(nextExecutorSort({ key: 'lastUsedAt', dir: 'desc' }, 'lastUsedAt'), { key: 'lastUsedAt', dir: 'asc' })

// Tag display: empty is an em dash, explicit tags truncate with +N, autoTags
// order by turn desc and never mutate the stored {tag: turn} object.
assert.equal(EXECUTOR_TAG_DISPLAY_LIMIT, 3)
assert.equal(executorTagText([], 3, false).text, '—')
assert.equal(executorTagText(null, 3, false).text, '—')
assert.equal(executorTagText({}, 3, true).text, '—')
const explicitTags = executorTagText(['a', 'b', 'c', 'd'], 3, false)
assert.equal(explicitTags.text, 'a, b, c +1')
assert.equal(explicitTags.full, 'a, b, c, d')
assert.equal(explicitTags.hidden, 1)
assert.equal(executorTagText(['a', 'b', 'c'], 2, false).text, 'a, b +1')
const autoTags = { code: 5, dsh: 9, ops: 1 }
const autoText = executorTagText(autoTags, 3, true)
assert.equal(autoText.text, 'dsh, code, ops')
assert.equal(autoText.full, 'dsh(9), code(5), ops(1)')
assert.deepEqual(Object.keys(autoTags), ['code', 'dsh', 'ops'], 'autoTags storage order is not mutated')

// Auto-tag entries: one sorted source for the cell and the tooltip table.
const ordered = executorAutoTagEntries({ cleanup: 17, docs: 17, 'dsh-ria': 11, noTurn: 'bad' })
assert.deepEqual(ordered.map(item => item.tag), ['cleanup', 'docs', 'dsh-ria', 'noTurn'])
assert.deepEqual(ordered.map(item => item.lastTurn), [17, 17, 11, null])
assert.deepEqual(Object.keys({ cleanup: 17, docs: 17, 'dsh-ria': 11 }), ['cleanup', 'docs', 'dsh-ria'], 'entries do not mutate storage')

// Current turn chain: row currentTurn first, then context map, including zero.
assert.equal(executorCurrentTurn({ currentTurn: 0 }, { currentTurnBySession: { s: 9 } }), 0)
assert.equal(executorCurrentTurn({ sessionId: 's' }, { currentTurnBySession: { s: 9 } }), 9)
assert.equal(executorCurrentTurn({ sessionId: 's', currentTurn: null }, { currentTurnBySession: { s: 0 } }), 0)
assert.equal(executorCurrentTurn({ sessionId: 's' }, {}), null)
assert.equal(executorCurrentTurn({}, { currentTurnBySession: { s: 9 } }), null)

// Tooltip rows: full ordered set, integer deltas, missing turn degrades to —.
const tooltipRows = executorAutoTagRows({ cleanup: 17, docs: 17, 'dsh-ria': 11, noTurn: 'bad' }, { sessionId: 's' }, { currentTurnBySession: { s: 17 } })
assert.deepEqual(tooltipRows.map(row => [row.tag, row.lastTurn, row.delta]), [
  ['cleanup', 17, 0],
  ['docs', 17, 0],
  ['dsh-ria', 11, 6],
  ['noTurn', null, null],
])
assert.deepEqual(executorAutoTagRows({}, { sessionId: 's' }, {}), [])
const textAuto = executorTagText({ cleanup: 17, docs: 17, 'dsh-ria': 11, noTurn: 'bad' }, 3, true)
assert.equal(textAuto.text, 'cleanup, docs, dsh-ria +1')
assert.equal(textAuto.hidden, 1)
assert.equal(source.includes('暂无自动标签'), true)
assert.equal(source.includes('记录轮次'), true)
assert.equal(source.includes('距今轮次'), true)
assert.equal(source.includes('data-ria-executor-autotags-tooltip'), true)
console.log('board executor sort ok')