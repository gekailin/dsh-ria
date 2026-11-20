import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFixture } from './support/ria-fixture.mjs'

const scriptPath = fileURLToPath(new URL('../scripts/migrate-memory.mjs', import.meta.url))
const run = (...args) => JSON.parse(execFileSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' }))
const read = file => readFileSync(file, 'utf8')

// 1) Migration: backup, migrate, idempotent, conflict, rollback.
{
  const dir = mkdtempSync(join(tmpdir(), 'ria-memory-migrate-'))
  try {
    mkdirSync(join(dir, 'cognition', 'chat'), { recursive: true })
    writeFileSync(join(dir, 'memory.md'), '# Memory\n\n- 偏好：先给结论，再展开。\n')
    writeFileSync(join(dir, 'cognition', 'chat', 'preferences.md'), '# Preferences\n\n')
    const backupRoot = join(dir, 'backups')

    const dry = run('--state', dir, '--backup', backupRoot, '--dry-run')
    assert.equal(dry.dryRun, true)
    assert.equal(dry.plan.changed, true)
    assert.equal(read(join(dir, 'cognition', 'chat', 'preferences.md')), '# Preferences\n\n', 'dry-run writes nothing')

    const first = run('--state', dir, '--backup', backupRoot)
    assert.equal(first.changed, true)
    assert.ok(first.backupDir && existsSync(first.backupDir))
    const migrated = read(join(dir, 'cognition', 'chat', 'preferences.md'))
    assert.match(migrated, /先给结论/)
    assert.match(migrated, /^# Preferences/)
    assert.equal(existsSync(join(dir, 'cognition', 'chat', '.memory-migrated.json')), true)
    assert.match(read(join(dir, 'memory.md')), /先给结论/, 'source memory.md is kept')

    const second = run('--state', dir, '--backup', backupRoot)
    assert.equal(second.changed, false)
    assert.equal(second.reason, 'already-migrated')
    assert.equal(read(join(dir, 'cognition', 'chat', 'preferences.md')), migrated)

    const restored = run('--restore', first.backupDir)
    assert.equal(restored.restored, true)
    assert.equal(read(join(dir, 'cognition', 'chat', 'preferences.md')), '# Preferences\n\n')
    assert.equal(existsSync(join(dir, 'cognition', 'chat', '.memory-migrated.json')), false)

    // Conflict: an existing non-empty preferences.md is never overwritten.
    const conflictDir = mkdtempSync(join(tmpdir(), 'ria-memory-conflict-'))
    try {
      mkdirSync(join(conflictDir, 'cognition', 'chat'), { recursive: true })
      writeFileSync(join(conflictDir, 'memory.md'), '- legacy preference\n')
      writeFileSync(join(conflictDir, 'cognition', 'chat', 'preferences.md'), '# Preferences\n\n- sage-owned preference\n')
      const conflict = run('--state', conflictDir, '--backup', join(conflictDir, 'backups'))
      assert.equal(conflict.changed, false)
      assert.equal(conflict.reason, 'conflict')
      assert.match(read(join(conflictDir, 'cognition', 'chat', 'preferences.md')), /sage-owned preference/)
      assert.equal(existsSync(join(conflictDir, 'cognition', 'chat', '.memory-migrated.json')), false)
    } finally {
      rmSync(conflictDir, { recursive: true, force: true })
    }
    console.log('memory migration script ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 2) bootstrapCognition no longer imports stateDir/memory.md.
{
  const dir = mkdtempSync(join(tmpdir(), 'ria-memory-bootstrap-'))
  const fixture = await createFixture({ v2Default: true, stateDir: dir })
  try {
    writeFileSync(join(dir, 'memory.md'), '# Memory\n\n- BOOTSTRAP-SECRET\n')
    rmSync(join(dir, 'cognition', '.bootstrapped'), { force: true })
    await fixture.service.v2.bootstrapCognition()
    const preferences = read(join(dir, 'cognition', 'chat', 'preferences.md'))
    assert.equal(preferences.includes('BOOTSTRAP-SECRET'), false)
    assert.match(preferences, /无历史记忆/)

    // 3) settings memoryStatus reads cognition/chat/, not memory.md.
    fixture.service.v2.cognition.write('chat/preferences.md', '- 用户偏好：先给结论。\n')
    fixture.service.v2.cognition.write('chat/decisions.md', '- 决策：保留审计证据。\n')
    const settings = fixture.service.settingsPayload()
    assert.ok(settings.memoryStatus.chars > 0)
    assert.ok(settings.memoryStatus.chars >= '- 用户偏好：先给结论。- 决策：保留审计证据。'.length - 4)
    console.log('memory bootstrap/status ok')
  } finally {
    fixture.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
}
