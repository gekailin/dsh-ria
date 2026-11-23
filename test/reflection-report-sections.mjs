import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { countReflectionIterationItems, parseMemoryCandidateTarget, parseMemoryCandidates, validateReflectionReport } from '../lib/reflection.mjs'

const markdown = readFileSync(new URL('./fixtures/reflection-report-2026-11-14.md', import.meta.url), 'utf8')
const run = {
  forDate: '2026-11-14',
  runId: 'refl-20261114-6f25a3',
  trigger: 'manual',
  executorSessionId: 'session-8c621973-167d-4b18-89df-c9b98f1f258c',
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

function numberedSection(count) {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1
    return [
      n + '. 第 ' + n + ' 条建议',
      '  - 问题：真实摩擦，证据 ticket_mwtest。',
      '  - 建议改法：lib/index.js:2077。',
      '  - 影响面：只影响 Ria。',
      '  - 优先级：P1。',
    ].join('\n')
  }).join('\n\n') + '\n'
}

function bulletGroupSection(count) {
  const labels = ['问题', '建议改法', '影响面', '优先级']
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1
    return labels.map(label => '- ' + label + '：第 ' + n + ' 条，证据 ticket_mwtest。').join('\n')
  }).join('\n\n') + '\n'
}

const fiveNumbered = validate(withIteration(numberedSection(5)))
assert.equal(fiveNumbered.ok, true, JSON.stringify(fiveNumbered))
assert.equal(countReflectionIterationItems(numberedSection(5)), 5)

const fiveGroups = validate(withIteration(bulletGroupSection(5)))
assert.equal(fiveGroups.ok, true, JSON.stringify(fiveGroups))
assert.equal(countReflectionIterationItems(bulletGroupSection(5)), 5)

const sixNumbered = validate(withIteration(numberedSection(6)))
assert.equal(sixNumbered.ok, false)
assert.match(sixNumbered.message, /at most 5 items/)

const sixGroups = validate(withIteration(bulletGroupSection(6)))
assert.equal(sixGroups.ok, false)
assert.match(sixGroups.message, /at most 5 items/)

assert.equal(countReflectionIterationItems('**1. 第一条**\n- 问题：x\n\n**2. 第二条**\n- 问题：y\n'), 2)

const realDraft = readFileSync(new URL('./fixtures/reflection-report-2026-11-16-d7c9c2.md', import.meta.url), 'utf8')
const realSection = realDraft.split('## 对 dsh-ria 的迭代建议')[1].split('## memory 候选')[0]
assert.equal(countReflectionIterationItems(realSection), 4)
const realRun = {
  forDate: '2026-11-16',
  runId: 'refl-fixture-20261116-d7c9c2',
  trigger: 'schedule',
  executorSessionId: 'session-1a71ab03-fbc8-4e2d-8b7e-c4f973ef1104',
  windowStart: Date.parse('2026-11-15T16:00:00.000Z'),
  windowEnd: Date.parse('2026-11-16T15:46:14.327Z'),
  attempt: 2,
}
const realReport = validateReflectionReport({ run: realRun, markdown: realDraft, status: 'complete' })
assert.equal(realReport.ok, true, JSON.stringify(realReport))

assert.deepEqual(parseMemoryCandidateTarget(undefined), { target: 'global', kind: 'global', sessionId: null })
assert.deepEqual(parseMemoryCandidateTarget('global'), { target: 'global', kind: 'global', sessionId: null })
assert.deepEqual(parseMemoryCandidateTarget('executor:session-abc'), { target: 'executor:session-abc', kind: 'executor', sessionId: 'session-abc' })
const invalid = parseMemoryCandidateTarget('team:ops')
assert.equal(invalid.target, 'global')
assert.match(invalid.warning, /invalid target "team:ops"/)

const candidatesMarkdown = [
  '## memory 候选',
  '- **flow-global** [target: global]：全局规则。',
  '- **flow-executor** [target: executor:session-abc]：给指定 executor 的规则。',
  '- **legacy**：没有 target 的旧格式。',
  '- **invalid** [target: team:ops]：非法 target 应降级。',
  '- **block**',
  '  target: executor:session-def',
  '  ：块序列写法。',
  '',
].join('\n')
const parsed = parseMemoryCandidates(candidatesMarkdown)
assert.equal(parsed.candidates.length, 5)
assert.deepEqual(parsed.candidates.map(item => item.target), [
  'global',
  'executor:session-abc',
  'global',
  'global',
  'executor:session-def',
])
assert.equal(parsed.candidates[0].rule, '全局规则。')
assert.equal(parsed.candidates[1].rule, '给指定 executor 的规则。')
assert.equal(parsed.candidates[2].rule, '没有 target 的旧格式。')
assert.equal(parsed.candidates[4].rule, '块序列写法。')
assert.equal(parsed.warnings.length, 1)
assert.match(parsed.warnings[0], /memory candidate invalid: invalid target "team:ops"/)

const targeted = validate(withIteration('无\n').replace(
  memoryHeading,
  memoryHeading + '- **executor-rule** [target: executor:session-abc]：给 executor 的规则。\n- **bad-rule** [target: team:ops]：降级。\n',
))
assert.equal(targeted.ok, true, JSON.stringify(targeted))
assert.equal(targeted.warnings.length, 1)
assert.match(targeted.warnings[0], /memory candidate bad-rule/)
assert.equal(targeted.memoryCandidates.find(item => item.key === 'executor-rule').target, 'executor:session-abc')
assert.equal(targeted.memoryCandidates.find(item => item.key === 'bad-rule').target, 'global')

console.log('reflection report sections ok')
