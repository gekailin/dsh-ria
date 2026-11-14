import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseReflectionFrontMatter, validateReflectionReport } from '../lib/reflection.mjs'

// Saved from ~/.dsh/state/ria/reflections/2026-11-14.md. The degraded list is
// kept in the block form the worker originally wrote; the file on disk was
// normalized to a flow list only after ria_reflect finish rejected it.
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
const expectedDegraded = [
  'read_session 对超长会话返回 truncated=true，主会话与 Ria开发只能按时间窗/索引分段读',
  'session-ddeb790b（2DGS demo）summary 返回 0 条消息，未能核对它的实际交付',
  '工具未暴露压缩/解压字节数与精确耗时；成本按各次 stats.omittedChars 估算',
]
const endOfFrontMatter = markdown.indexOf('\n---\n')

function replaceDegraded(replacement) {
  const start = markdown.indexOf('degraded:\n')
  assert.ok(start >= 0, 'fixture must have a degraded list')
  assert.ok(endOfFrontMatter > start, 'fixture must close its front matter')
  return markdown.slice(0, start) + replacement + markdown.slice(endOfFrontMatter)
}

function validate(text) {
  return validateReflectionReport({ run, markdown: text, status: 'complete' })
}

const checked = validate(markdown)
assert.equal(checked.ok, true, JSON.stringify(checked))
assert.equal(checked.status, 'complete')
assert.deepEqual(checked.frontMatter.degraded, expectedDegraded)

const flow = replaceDegraded("degraded: [\"a, b\", 'it''s', plain]")
const parsedFlow = parseReflectionFrontMatter(flow)
assert.equal(parsedFlow.ok, true, JSON.stringify(parsedFlow))
assert.deepEqual(parsedFlow.data.degraded, ['a, b', "it's", 'plain'])
assert.equal(validate(flow).ok, true)

const empty = validate(replaceDegraded('degraded: []'))
assert.equal(empty.ok, true, JSON.stringify(empty))
assert.deepEqual(empty.frontMatter.degraded, [])

const quoted = parseReflectionFrontMatter([
  '---',
  'degraded:',
  "  - 'it''s, fine'",
  '  - "say \\"hi\\" and \\\\ slash"',
  '---',
  '',
].join('\n'))
assert.equal(quoted.ok, true, JSON.stringify(quoted))
assert.deepEqual(quoted.data.degraded, ["it's, fine", 'say "hi" and \\ slash'])

const unclosed = validate(markdown.replace('\n---\n## 一句话\n', '\n## 一句话\n'))
assert.equal(unclosed.ok, false)
assert.equal(unclosed.code, 'report_front_matter')
assert.match(unclosed.message, /not closed/)

const scalar = validate(replaceDegraded('degraded: this is not an array'))
assert.equal(scalar.ok, false)
assert.equal(scalar.code, 'report_invalid')
assert.match(scalar.message, /degraded must be an array/)

console.log('reflection front matter ok')
