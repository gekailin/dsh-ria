import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('/* board-executor-co:start */')
const end = source.indexOf('/* board-executor-co:end */')
assert.ok(start >= 0 && end > start, 'executor co status markers')
const block = source.slice(start + '/* board-executor-co:start */'.length, end)
const api = new Function('boardDateTime', block + '\nreturn { executorCoStatusInfo, executorCoStatusRank };')(value => 'T' + value)

const active = api.executorCoStatusInfo({ coManagement: { status: 'active', allowDispatch: true, addedAt: 123 } })
assert.equal(active.kind, 'active')
assert.equal(active.label, 'active')
assert.equal(active.color, '#047857')
assert.match(active.title, /自动派活：是/)
assert.match(active.title, /加入时间：T123/)
assert.doesNotMatch(active.title, /retire/)

const inactive = api.executorCoStatusInfo({ coManagement: { status: 'inactive', allowDispatch: false, addedAt: 456, retiredReason: 'archived' } })
assert.equal(inactive.kind, 'inactive')
assert.equal(inactive.label, 'inactive')
assert.equal(inactive.color, '#94a3b8')
assert.match(inactive.title, /自动派活：否/)
assert.match(inactive.title, /加入时间：T456/)
assert.match(inactive.title, /retire 原因：archived/)

const unmanaged = api.executorCoStatusInfo({ sessionId: 'session-x' })
assert.equal(unmanaged.kind, 'unmanaged')
assert.equal(unmanaged.label, '—')
assert.equal(unmanaged.color, '')
assert.equal(api.executorCoStatusRank({ coManagement: { status: 'active' } }), 0)
assert.equal(api.executorCoStatusRank({ coManagement: { status: 'inactive' } }), 1)
assert.equal(api.executorCoStatusRank({}), 2)

assert.match(source, /executorSortHeader\("协管状态", "coManagement"/)
assert.match(source, /"data-ria-executor-co-status": info\.kind/)
assert.match(source, /function executorTable\(rows, sort, setSort, table, emptyText\)/)
// Both active and archived tables use the same executorTable function.
const tableCalls = source.match(/executorTable\(/g) || []
assert.ok(tableCalls.length >= 3, 'active and archived tables share executorTable')
console.log('executor co status ok')
