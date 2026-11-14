import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseMemoryCandidateTarget, parseMemoryCandidates, validateReflectionReport } from '../lib/reflection.mjs'

const markdown = readFileSync(new URL('./fixtures/reflection-report-2026-11-14.md', import.meta.url), 'utf8')
const run = {
  forDate: '2026-11-14',
  runId: 'refl-20261114-6f25a3',
  trigger: 'manual',
  workerSessionId: 'session-8c621973-167d-4b18-89df-c9b98f1f258c',
  windowStart: Date.parse('2026-11-13T16:00:00.000Z'),
  windowEnd: Date.parse('2026-11-14T05:45:57.050Z'),
  attempt: 1,
}

function validate(text) {
  return validateReflectionReport({ run, markdown: text, status: 'complete' })
}

const memoryHeading = '\n## memory 候选\n'
function withIteration(content) {
  assert.ok(markdown.includes(memoryHeading), 'fixture must have a memory section')
  return markdown.replace(memoryHeading, '\n## 对 dsh-ria 的迭代建议\n' + content + memoryHeading)
}

const oldReport = validate(markdown)
assert.equal(oldReport.ok, true, JSON.stringify(oldReport))
assert.deepEqual(oldReport.warnings, [])
assert.equal(oldReport.memoryCandidates.length, 3)
assert.ok(oldReport.memoryCandidates.every(item => item.target === 'global'))

const empty = validate(withIteration(''))
assert.equal(empty.ok, false)
assert.equal(empty.code, 'report_invalid')
assert.match(empty.message, /heading 对 dsh-ria 的迭代建议 must not be empty/)

const none = validate(withIteration('无\n'))
assert.equal(none.ok, true, JSON.stringify(none))

const five = validate(withIteration(Array.from({ length: 5 }, (_, index) => (
  '- 问题：第 ' + (index + 1) + ' 条真实摩擦，证据 ticket_mwtest。建议改法：lib/index.js:2077。影响面：只影响 Ria。优先级：P1。'
)).join('\n') + '\n'))
assert.equal(five.ok, true, JSON.stringify(five))

const six = validate(withIteration(Array.from({ length: 6 }, (_, index) => (
  '- 问题：第 ' + (index + 1) + ' 条，证据 ticket_mwtest。建议改法：lib/index.js:2077。影响面：只影响 Ria。优先级：P2。'
)).join('\n') + '\n'))
assert.equal(six.ok, false)
assert.match(six.message, /at most 5 items/)

assert.deepEqual(parseMemoryCandidateTarget(undefined), { target: 'global', kind: 'global', sessionId: null })
assert.deepEqual(parseMemoryCandidateTarget('global'), { target: 'global', kind: 'global', sessionId: null })
assert.deepEqual(parseMemoryCandidateTarget('worker:session-abc'), { target: 'worker:session-abc', kind: 'worker', sessionId: 'session-abc' })
const invalid = parseMemoryCandidateTarget('team:ops')
assert.equal(invalid.target, 'global')
assert.match(invalid.warning, /invalid target "team:ops"/)

const candidatesMarkdown = [
  '## memory 候选',
  '- **flow-global** [target: global]：全局规则。',
  '- **flow-worker** [target: worker:session-abc]：给指定 worker 的规则。',
  '- **legacy**：没有 target 的旧格式。',
  '- **invalid** [target: team:ops]：非法 target 应降级。',
  '- **block**',
  '  target: worker:session-def',
  '  ：块序列写法。',
  '',
].join('\n')
const parsed = parseMemoryCandidates(candidatesMarkdown)
assert.equal(parsed.candidates.length, 5)
assert.deepEqual(parsed.candidates.map(item => item.target), [
  'global',
  'worker:session-abc',
  'global',
  'global',
  'worker:session-def',
])
assert.equal(parsed.candidates[0].rule, '全局规则。')
assert.equal(parsed.candidates[1].rule, '给指定 worker 的规则。')
assert.equal(parsed.candidates[2].rule, '没有 target 的旧格式。')
assert.equal(parsed.candidates[4].rule, '块序列写法。')
assert.equal(parsed.warnings.length, 1)
assert.match(parsed.warnings[0], /memory candidate invalid: invalid target "team:ops"/)

const targeted = validate(withIteration('无\n').replace(
  memoryHeading,
  memoryHeading + '- **worker-rule** [target: worker:session-abc]：给 worker 的规则。\n- **bad-rule** [target: team:ops]：降级。\n',
))
assert.equal(targeted.ok, true, JSON.stringify(targeted))
assert.equal(targeted.warnings.length, 1)
assert.match(targeted.warnings[0], /memory candidate bad-rule/)
assert.equal(targeted.memoryCandidates.find(item => item.key === 'worker-rule').target, 'worker:session-abc')
assert.equal(targeted.memoryCandidates.find(item => item.key === 'bad-rule').target, 'global')

console.log('reflection report sections ok')
