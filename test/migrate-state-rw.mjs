import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/migrate-state-rw.mjs', import.meta.url))
const run = (...args) => JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' }))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

const dir = mkdtempSync(join(tmpdir(), 'ria-migrate-rw-'))
try {
  mkdirSync(join(dir, 'cognition', 'chatbot'), { recursive: true })
  mkdirSync(join(dir, 'cognition', 'chat'), { recursive: true })
  writeFileSync(join(dir, 'cognition', 'chatbot', 'preferences.md'), '旧偏好 keep')
  writeFileSync(join(dir, 'cognition', 'chatbot', 'decisions.md'), '旧决策')
  writeFileSync(join(dir, 'cognition', 'chat', 'decisions.md'), 'existing chat decision')
  writeFileSync(join(dir, 'cognition', 'principles.md'), 'principles')
  writeFileSync(join(dir, 'v2.json'), JSON.stringify({
    schemaVersion: 1,
    chatbotSessionId: 'session-chat',
    sageSessionId: null,
    advisorMode: 'legacy',
    advisors: {},
    workers: {},
    lastError: { scope: 'chatbot', message: 'old failure' },
  }, null, 2))
  writeFileSync(join(dir, 'ria.json'), JSON.stringify({
    tickets: [{ ticketId: 't1', executor: 'worker', history: [{ actor: 'chatbot' }, { actor: 'user' }], resolution: { by: 'chatbot' } }],
  }, null, 2))
  writeFileSync(join(dir, 'co-management.json'), JSON.stringify({ items: [{ addedBy: 'chatbot' }] }, null, 2))

  const backupRoot = join(dir, 'backups')
  const first = run('--state', dir, '--backup', backupRoot)
  assert.equal(first.changed, true)


  assert.ok(first.backupDir && existsSync(first.backupDir), 'backup directory must exist')
  assert.ok(first.backupDir.startsWith(backupRoot))
  const afterV2 = readJson(join(dir, 'v2.json'))
  assert.equal(afterV2.chatSessionId, 'session-chat')
  assert.equal('chatbotSessionId' in afterV2, false)
  assert.equal('advisorMode' in afterV2, false)
  assert.equal('sagePromptText' in afterV2, false)
  assert.equal(afterV2.lastError.scope, 'chat')
  const afterRia = readJson(join(dir, 'ria.json'))
  assert.equal(afterRia.tickets[0].history[0].actor, 'chat')
  assert.equal(afterRia.tickets[0].history[1].actor, 'user')
  assert.equal(afterRia.tickets[0].resolution.by, 'chat')
  assert.equal(readJson(join(dir, 'co-management.json')).items[0].addedBy, 'chat')
  // Moved, not reset.
  assert.equal(readFileSync(join(dir, 'cognition', 'chat', 'preferences.md'), 'utf8'), '旧偏好 keep')
  assert.equal(existsSync(join(dir, 'cognition', 'chatbot', 'preferences.md')), false)
  // Conflict: target exists, so the old file stays put and is reported.
  assert.equal(readFileSync(join(dir, 'cognition', 'chatbot', 'decisions.md'), 'utf8'), '旧决策')
  assert.equal(readFileSync(join(dir, 'cognition', 'chat', 'decisions.md'), 'utf8'), 'existing chat decision')
  assert.ok(first.plan.conflicts.some(item => item.name === 'decisions.md'))
  assert.ok(first.plan.changes.some(item => item.field === 'chatbotSessionId'))

  // Idempotent: a second run changes nothing and writes no new backup.
  const backupsAfter = readdirSync(backupRoot).length
  const second = run('--state', dir, '--backup', backupRoot)
  assert.equal(second.changed, false)
  assert.equal(second.backupDir, null)
  assert.equal(readdirSync(backupRoot).length, backupsAfter)

  // Rollback restores the pre-migration files.
  const restored = run('--restore', first.backupDir)
  assert.ok(restored.restored.includes('v2.json'))
  const rolledV2 = readJson(join(dir, 'v2.json'))
  assert.equal(rolledV2.chatbotSessionId, 'session-chat')
  assert.equal(rolledV2.advisorMode, 'legacy')
  assert.equal(readFileSync(join(dir, 'cognition', 'chatbot', 'preferences.md'), 'utf8'), '旧偏好 keep')
  assert.equal(existsSync(join(dir, 'cognition', 'chat', 'preferences.md')), false, 'rollback removes files the migration created')

  // Dry-run computes the plan and writes nothing.
  const dry = run('--state', dir, '--dry-run')
  assert.equal(dry.dryRun, true)
  assert.equal(readJson(join(dir, 'v2.json')).chatbotSessionId, 'session-chat')

  console.log('migrate state rw ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
