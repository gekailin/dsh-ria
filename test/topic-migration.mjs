import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectKey } from '../lib/v2/cognition.mjs'
import { normalizeTopic } from '../lib/topics.mjs'

const readJson = file => JSON.parse(readFileSync(file, 'utf8'))

// 1) Model: projectKey/tags in, level/parentId out (old rows stay readable).
{
  const topic = normalizeTopic({
    topicId: 'topic_old',
    title: '旧主题',
    level: 2,
    parentId: 'topic_parent',
    projectKey: '  dsh-ria-abc  ',
    tags: [' Frontend ', 'SQLite', 'frontend', 'a_b'],
    brief: '说明',
  })
  assert.equal(topic.projectKey, 'dsh-ria-abc')
  assert.deepEqual(topic.tags, ['frontend', 'sqlite', 'a-b'])
  assert.equal('level' in topic, false)
  assert.equal('parentId' in topic, false)
  const minimal = normalizeTopic({ topicId: 'topic_min', title: 'T' })
  assert.equal(minimal.projectKey, null)
  assert.deepEqual(minimal.tags, [])
  console.log('normalizeTopic projectKey/tags ok')
}

// 2) Migration: derive projectKey from ancestors, orphan -> null, idempotent, rollback.
{
  const dir = mkdtempSync(join(tmpdir(), 'ria-topics-migrate-'))
  const scriptPath = fileURLToPath(new URL('../scripts/migrate-topics.mjs', import.meta.url))
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' }))
  try {
    const workspace = '/tmp/ria-topic-migration-project'
    const expected = projectKey(workspace)
    const original = {
      tickets: [],
      topics: [
        { topicId: 'parent', title: '父主题', level: 1, projectCwd: workspace, createdAt: 1, updatedAt: 1 },
        { topicId: 'child', title: '子主题', level: 2, parentId: 'parent', createdAt: 1, updatedAt: 1 },
        { topicId: 'orphan', title: '无归属', level: 2, parentId: 'missing', createdAt: 1, updatedAt: 1 },
        { topicId: 'explicit', title: '显式项目', projectKey: 'explicit-key', tags: ['Docs'], createdAt: 1, updatedAt: 1 },
      ],
    }
    writeFileSync(join(dir, 'ria.json'), JSON.stringify(original, null, 2) + '\n')

    const dry = run('--state', dir, '--backup', join(dir, 'backups'), '--dry-run')
    assert.equal(dry.plan.changed, true)
    assert.equal(readJson(join(dir, 'ria.json')).topics[0].level, 1, 'dry-run writes nothing')

    const first = run('--state', dir, '--backup', join(dir, 'backups'))
    assert.equal(first.changed, true)
    assert.ok(first.backupDir && existsSync(first.backupDir))
    const migrated = readJson(join(dir, 'ria.json')).topics
    const byId = new Map(migrated.map(topic => [topic.topicId, topic]))
    assert.equal(byId.get('parent').projectKey, expected)
    assert.equal(byId.get('child').projectKey, expected, 'parent projectCwd is inherited')
    assert.equal(byId.get('orphan').projectKey, null, 'no hint falls back to null')
    assert.equal(byId.get('explicit').projectKey, 'explicit-key')
    assert.deepEqual(byId.get('explicit').tags, ['docs'])
    for (const topic of migrated) {
      assert.equal('level' in topic, false)
      assert.equal('parentId' in topic, false)
      assert.ok(Array.isArray(topic.tags))
    }

    const backupsAfter = readdirSync(join(dir, 'backups')).length
    const second = run('--state', dir, '--backup', join(dir, 'backups'))
    assert.equal(second.changed, false)
    assert.equal(second.reason, 'already-migrated')
    assert.equal(readdirSync(join(dir, 'backups')).length, backupsAfter)

    const restored = run('--restore', first.backupDir)
    assert.equal(restored.restored, true)
    const rolled = readJson(join(dir, 'ria.json')).topics
    assert.equal(rolled[0].level, 1)
    assert.equal(rolled[0].parentId, undefined)
    console.log('topics migration ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
