import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('/* board-markdown:start */')
const detailStart = source.indexOf('function TicketDetailDialog')
assert.ok(start >= 0 && detailStart > start, 'markdown block markers')

function createElement(type, props) {
  var children = Array.prototype.slice.call(arguments, 2).flat(Infinity)
  return { type, props: props || {}, children }
}
const block = source.slice(start, detailStart)
const api = new Function('React', block + '\nreturn { markdownParse, markdownInline, renderMarkdown, ticketDetailSections };')({ createElement })
const { markdownParse, markdownInline, renderMarkdown, ticketDetailSections } = api

// Fenced code blocks.
const code = markdownParse('\u0060\u0060\u0060js\nconst answer = 42\n\u0060\u0060\u0060')
assert.equal(code.length, 1)
assert.equal(code[0].type, 'code')
assert.equal(code[0].lang, 'js')
assert.equal(code[0].text, 'const answer = 42')

// Tables (header, alignment row, body rows).
const table = markdownParse('| 字段 | 值 |\n| --- | ---: |\n| a | 1 |\n| b | 2 |')
assert.equal(table.length, 1)
assert.equal(table[0].type, 'table')
assert.deepEqual(table[0].header, ['字段', '值'])
assert.deepEqual(table[0].align, ['left', 'right'])
assert.deepEqual(table[0].rows, [['a', '1'], ['b', '2']])

// Ordered and unordered lists, including task checkboxes.
const list = markdownParse('- one\n- two\n\n1. first\n2. [x] done')
assert.equal(list.length, 2)
assert.equal(list[0].type, 'list')
assert.equal(list[0].ordered, false)
assert.deepEqual(list[0].items.map(item => item.text), ['one', 'two'])
assert.equal(list[1].ordered, true)
assert.equal(list[1].items[1].checked, true)

// Inline formatting: code, bold, link.
assert.deepEqual(markdownInline('a \u0060b\u0060 **c** [d](https://example.com)'), [
  { type: 'text', text: 'a ' },
  { type: 'code', text: 'b' },
  { type: 'text', text: ' ' },
  { type: 'strong', text: 'c' },
  { type: 'text', text: ' ' },
  { type: 'link', text: 'd', href: 'https://example.com' },
])

// The renderer emits React elements (never HTML) for code/table/list.
function collectTypes(node, out) {
  if (!node || typeof node !== 'object') return out
  if (node.props && node.props['data-ria-md-block']) out.push(node.props['data-ria-md-block'])
  for (const child of node.children || []) collectTypes(child, out)
  return out
}
const rendered = renderMarkdown('\u0060\u0060\u0060js\nconst answer = 42\n\u0060\u0060\u0060\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- one\n- two')
const kinds = collectTypes(rendered, [])
assert.ok(kinds.includes('code'), 'renderer emits a code block')
assert.ok(kinds.includes('table'), 'renderer emits a table')
assert.ok(kinds.includes('list'), 'renderer emits a list')

// Empty text renders a placeholder, not an empty div.
const empty = renderMarkdown('   ')
assert.equal(empty.type, 'span')
assert.equal(empty.children[0], '—')

// Ticket detail section plan: every top-level ticket field belongs to exactly
// one section, and unknown fields are kept under 元数据.
const sample = {
  ticketId: 'ticket_1', status: 'blocked', goal: '## 目标', acceptance: '- [ ] 验收',
  executor: 'session-a', waitingOn: 'user', origin: { kind: 'chat', text: 'hi', at: 1 },
  parentTicketId: null, rootTicketId: 'ticket_1', forkDepth: 0, childTicketIds: [],
  dependsOn: ['ticket_0'], checklist: [{ text: 'step', done: true }], readyAt: null,
  readyNotifiedAt: null, dependencyAlerts: [], fork: null, attempt: { count: 1 },
  attempts: [], lastExecutorTurn: null, progress: { lastPhase: 'x' }, recovery: null,
  blockedReason: 'need input', attention: { kind: 'decision', question: 'which?' },
  failure: { code: 'x', message: 'boom' }, resolution: { kind: 'done', summary: 'ok', evidence: ['file:1'] },
  history: [{ at: 2, actor: 'ria', from: 'open', to: 'blocked', reason: 'wait' }],
  feedback: { lastAt: 0, lastKind: '' }, nudgeCount: 0, reopenCount: 0, revision: 2,
  createdAt: 1, updatedAt: 2, closedAt: null, archived: false, dependentCount: 1,
  executorTitle: 'Exec', executorCwd: '/work', executorArchived: false, executorMissing: false,
  executorTags: ['t'], executorRoleNote: 'role', projectTitle: 'proj', projectKey: 'p',
  projectCwd: '/work', laneId: 'l', laneLabel: 'L', queueState: 'idle', queueText: 'q',
  primaryTopicId: 'topic_1', unknownFutureField: 'keep me'
}
const sections = ticketDetailSections(sample, { ticket: sample, lastResult: { text: 'ok', turn: 1, outcome: 'completed' } })
assert.deepEqual(sections.map(section => section.id), ['basic', 'report', 'history', 'metadata'])
const keys = sections.flatMap(section => section.entries.map(entry => entry.key))
assert.equal(new Set(keys).size, keys.length, 'no field is assigned to two sections')
for (const key of Object.keys(sample)) assert.ok(keys.includes(key), 'missing field: ' + key)
assert.ok(keys.includes('lastResult'), 'detail lastResult is rendered')
assert.ok(sections.find(section => section.id === 'metadata').entries.some(entry => entry.key === 'unknownFutureField'))
assert.equal(sections.find(section => section.id === 'report').entries.find(entry => entry.key === 'resolution').kind, 'resolution')
assert.equal(sections.find(section => section.id === 'basic').entries.find(entry => entry.key === 'goal').kind, 'markdown')
assert.doesNotMatch(source, /dangerouslySetInnerHTML/)

console.log('board markdown ok')
