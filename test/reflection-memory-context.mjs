import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaService } from '../lib/index.js'
import { readMemoryContext } from '../lib/reflection.mjs'
import { openDatabase } from '../lib/state/sqlite/db.mjs'

const root = mkdtempSync(join(tmpdir(), 'ria-reflect-memory-'))
try {
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  const db = openDatabase(join(stateDir, 'ria.sqlite'), { create: true })
  try {
    const insert = db.prepare('INSERT INTO cognition_entries(id,scope,kind,status,tags,body,cause,sources,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    insert.run('cog_1', 'user:preference', 'preference', 'active', '[]', '偏好内容', 'test', '[]', 'sage', 1, 1)
    insert.run('cog_2', 'user:agreement', 'agreement', 'active', '[]', '约定内容', 'test', '[]', 'sage', 1, 1)
    insert.run('cog_3', 'global', 'experience', 'active', '[]', '决策内容', 'test', '[]', 'sage', 1, 1)
    db.prepare('INSERT INTO cognition_projects(project_id,name,workspaces,overview,status,updated_at) VALUES(?,?,?,?,?,?)').run('dsh-ria', 'DSH Ria', JSON.stringify(['/tmp/dsh-ria']), '项目概况', 'active', 1)
  } finally { db.close() }

  const context = readMemoryContext(stateDir)
  assert.match(context.text, /偏好内容/)
  assert.match(context.text, /约定内容/)
  assert.match(context.text, /DSH Ria/)
  assert.ok(context.bytes > 0)

  const callContext = service => RiaService.prototype.toolReflectReadContext.call({
    stateDir,
    reflectionRunFor: () => ({ status: 'running' }),
    reflectionClosed: () => ({ ok: false, code: 'run_closed' }),
    outbox: { all: () => [] },
  }, 'session-test', 'run-test', { kind: 'memory' })
  const viaTool = callContext()
  assert.match(viaTool.text, /偏好内容/)
  assert.match(viaTool.text, /DSH Ria/)

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
