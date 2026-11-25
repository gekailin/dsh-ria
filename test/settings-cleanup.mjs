import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RiaStore } from '../lib/index.js'
import { createFixture } from './support/ria-fixture.mjs'

// Settings cleanup: the memory-budget section and the per-reflection model
// override are gone; custom voice text fully replaces the preset text.

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const index = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

// 1) The two settings sections and their field names are gone from the client.
for (const marker of [
  'data-ria-memory',
  '记忆预算',
  '记忆配置',
  'data-ria-reflection-advanced',
  'data-ria-reflection-field',
  'reflectionAdvancedUpdate',
  '自定义补充',
  '用户在预设之上追加',
]) {
  assert.equal(client.includes(marker), false, 'client still contains removed settings marker: ' + marker)
}
assert.ok(client.includes('完全覆盖'), 'style hint explains the full override')
assert.ok(client.includes('data-ria-style-custom'), 'custom style control is kept')

// 2) Backend memory budget plumbing is gone with its only consumer.
assert.equal(existsSync(new URL('../lib/memory.mjs', import.meta.url)), false, 'memory budget module removed')
for (const marker of ['normalizeMemorySettings', 'memoryStatusView', 'MEMORY_SETTINGS', 'memorySettings(', 'body.memory', 'settings.memory']) {
  assert.equal(index.includes(marker), false, 'server still contains removed memory setting: ' + marker)
}
assert.equal(/from '\.\/memory\.mjs'/.test(index), false, 'no import of the deleted memory module')
assert.equal(index.includes("'memory' in patch"), false, 'settings patch no longer writes memory')

// 3) A store loaded from legacy state ignores the old keys instead of throwing.
const root = mkdtempSync(join(tmpdir(), 'ria-settings-cleanup-'))
try {
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'ria.json'), '{}\n')
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
    settings: {
      memory: { maxChars: 9999, maxEntries: 50, maxEntryChars: 2000 },
      reflection: { enabled: false, cadence: 'weekly', time: '09:05', weekday: 3, model: 'legacy-model', provider: 'legacy-provider', reasoningEffort: 'high' },
      style: { enabled: true, preset: 'warm', custom: 'legacy custom' },
    },
  }) + '\n')
  const legacy = new RiaStore(stateDir)
  const loaded = legacy.settings()
  assert.equal(Object.hasOwn(loaded, 'memory'), false, 'legacy settings.memory is ignored')
  assert.deepEqual(Object.keys(loaded.reflection).sort(), ['cadence', 'enabled', 'time', 'weekday'])
  for (const key of ['model', 'provider', 'reasoningEffort']) {
    assert.equal(Object.hasOwn(loaded.reflection, key), false, 'legacy reflection model key dropped: ' + key)
  }
  assert.equal(loaded.reflection.time, '09:05', 'non-model reflection settings are preserved')
  assert.equal(loaded.reflection.cadence, 'weekly')
  assert.equal(loaded.reflection.weekday, 3)
  assert.equal(loaded.style.custom, 'legacy custom')
} finally {
  rmSync(root, { recursive: true, force: true })
}

// 4) Live settings payload, style override and the 300-char cap.
const fixture = await createFixture({ stateDefault: true })
try {
  const store = fixture.service.store
  const controller = fixture.service.controller
  const payload = fixture.service.settingsPayload()
  assert.equal(Object.hasOwn(payload, 'memory'), false)
  assert.equal(Object.hasOwn(payload, 'memoryStatus'), false)
  assert.deepEqual(Object.keys(payload.reflection).sort(), ['cadence', 'enabled', 'time', 'weekday'])
  assert.equal(payload.reflection.enabled, false, 'reflection.enabled is kept')

  store.setSettings({ style: { enabled: true, preset: 'concise', custom: '' } })
  const defaultPrompt = controller.chatSystemPrompt('BASE', {})
  assert.ok(defaultPrompt.includes('能一句不两句'), 'empty custom falls back to the preset style')

  store.setSettings({ style: { enabled: true, preset: 'concise', custom: '只用短句，先给结论。' } })
  const customPrompt = controller.chatSystemPrompt('BASE', {})
  assert.ok(customPrompt.includes('只用短句，先给结论。'))
  assert.equal(customPrompt.includes('能一句不两句'), false, 'custom style must not be appended to the default preset')
  assert.ok(customPrompt.includes('边界（固定写死，与预设无关）'), 'fixed content boundaries still apply')

  store.setSettings({ style: { enabled: true, custom: '龘'.repeat(600) } })
  const longPrompt = controller.chatSystemPrompt('BASE', {})
  const longCount = (longPrompt.match(/龘/g) || []).length
  assert.equal(longCount, 300, 'custom style keeps its 300-char storage cap (<=500)')
  assert.ok(longCount <= 500)

  store.setSettings({ style: { enabled: false, custom: '不会注入' } })
  assert.equal(controller.chatSystemPrompt('BASE', {}).includes('[说话风格]'), false)
  console.log('settings cleanup/style override ok')
} finally {
  fixture.cleanup()
}
