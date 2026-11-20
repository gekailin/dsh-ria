import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaService } from '../lib/index.js'
import { readMemoryContext } from '../lib/reflection.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-reflect-memory-'))
try {
  const stateDir = join(root, 'state')
  mkdirSync(join(stateDir, 'cognition', 'chat'), { recursive: true })
  writeFileSync(join(stateDir, 'cognition', 'chat', 'preferences.md'), '# Preferences\n\n- **pref**: 偏好内容\n')
  writeFileSync(join(stateDir, 'cognition', 'chat', 'agreements.md'), '# Agreements\n\n- 约定内容\n')
  writeFileSync(join(stateDir, 'cognition', 'chat', 'decisions.md'), '# Decisions\n\n- 决策内容\n')

  const context = readMemoryContext(stateDir)
  assert.match(context.text, /偏好内容/)
  assert.match(context.text, /约定内容/)
  assert.match(context.text, /决策内容/)
  assert.ok(context.bytes > 0)

  const callContext = service => RiaService.prototype.toolReflectReadContext.call({
    stateDir,
    reflectionRunFor: () => ({ status: 'running' }),
    reflectionClosed: () => ({ ok: false, code: 'run_closed' }),
    outbox: { all: () => [] },
  }, 'session-test', 'run-test', { kind: 'memory' })
  const viaTool = callContext()
  assert.match(viaTool.text, /偏好内容/)
  assert.match(viaTool.text, /决策内容/)

  const emptyDir = join(root, 'empty')
  mkdirSync(emptyDir, { recursive: true })
  const empty = readMemoryContext(emptyDir)
  assert.match(empty.text, /暂无记忆/)
  assert.notEqual(empty.text, '')
  const emptyViaTool = RiaService.prototype.toolReflectReadContext.call({
    stateDir: emptyDir,
    reflectionRunFor: () => ({ status: 'running' }),
    reflectionClosed: () => ({}),
    outbox: { all: () => [] },
  }, 'session-test', 'run-test', { kind: 'memory' })
  assert.match(emptyViaTool.text, /暂无记忆/)
  console.log('reflection memory context ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
