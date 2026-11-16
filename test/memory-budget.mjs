import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture } from './support/ria-fixture.mjs'
import { measureText } from '../lib/text-size.mjs'
import { managerPrompt } from '../lib/index.js'
import { memoryPromptPayload } from '../lib/memory.mjs'

const fixture = await createFixture()
const store = fixture.service.store
const memoryFile = join(fixture.stateDir, 'memory.md')
const archiveDir = join(fixture.stateDir, 'memory-archive')

function resetMemory(settings = {}) {
  store.setSettings({ memory: { maxChars: 2400, maxEntries: 12, maxEntryChars: 300, ...settings } })
  store.writeMemory('')
}

function request(method, path, payload) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = { host: '127.0.0.1:3080' }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(body) { this.body = body; this.done(body) },
  }
  const done = new Promise(resolve => { res.done = resolve })
  fixture.routes[0].handler(req, res)
  setImmediate(() => {
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
  })
  return done.then(body => ({ status: res.statusCode, body: JSON.parse(body) }))
}

try {
  // The one measurement helper owns the unit split: code points vs UTF-8 bytes.
  assert.deepEqual(measureText('阿汐'), { chars: 2, bytes: 6 })
  assert.deepEqual(measureText('e\u0301'), { chars: 2, bytes: 3 })
  assert.deepEqual(measureText('😀'), { chars: 1, bytes: 4 })
  assert.deepEqual(measureText('abc'), { chars: 3, bytes: 3 })

  resetMemory()
  const empty = await fixture.call('ria_memory', { action: 'read' })
  assert.equal(empty.ok, true)
  assert.equal(empty.scope, 'core')
  assert.deepEqual(
    [empty.chars, empty.bytes, empty.entries, empty.maxChars, empty.maxEntries, empty.maxEntryChars],
    [0, 0, 0, 2400, 12, 300],
  )
  assert.deepEqual(empty.archives, [])

  const remembered = await fixture.call('ria_memory', { action: 'remember', key: 'name', text: '阿汐' })
  assert.equal(remembered.ok, true)
  assert.equal(remembered.entries, 1)
  assert.equal(remembered.chars, measureText('- **name**: 阿汐').chars)
  assert.equal(remembered.bytes, measureText('- **name**: 阿汐\n').bytes)
  const readAfter = await fixture.call('ria_memory', { action: 'read' })
  assert.match(readAfter.text, /- \*\*name\*\*: 阿汐/)

  // 90% is a warning, not a refusal.
  resetMemory({ maxChars: 500, maxEntryChars: 2000 })
  const near = await fixture.call('ria_memory', { action: 'remember', text: 'a'.repeat(450) })
  assert.equal(near.ok, true)
  assert.equal(near.chars, 452)
  assert.match(near.warning, /near budget/)
  assert.equal(near.warnings.length, 1)

  // Each hard limit rejects the whole write and leaves the file untouched.
  resetMemory({ maxChars: 500, maxEntryChars: 2000 })
  await assert.rejects(
    () => fixture.call('ria_memory', { action: 'remember', text: 'a'.repeat(500) }),
    error => /memory\.md not written: 502\/500 chars \(\+2\)/.test(error.message) && /No changes were made\./.test(error.message),
  )
  assert.equal(store.readMemory(), '')

  resetMemory({ maxEntries: 1 })
  await fixture.call('ria_memory', { action: 'remember', key: 'one', text: 'x' })
  const beforeReject = store.readMemory()
  await assert.rejects(
    () => fixture.call('ria_memory', { action: 'remember', key: 'two', text: 'y' }),
    error => /2\/1 entries \(\+1\)/.test(error.message) && /No changes were made\./.test(error.message),
  )
  assert.equal(store.readMemory(), beforeReject)

  resetMemory({ maxEntryChars: 50 })
  await assert.rejects(
    () => fixture.call('ria_memory', { action: 'remember', text: 'a'.repeat(60) }),
    error => /62\/50 chars \(\+12\)/.test(error.message) && /No changes were made\./.test(error.message),
  )
  assert.equal(store.readMemory(), '')

  // Chars decide the budget. A UTF-8-heavy entry may have more bytes than the
  // char limit and must still fit.
  resetMemory({ maxChars: 500, maxEntryChars: 500, maxEntries: 12 })
  const wide = await fixture.call('ria_memory', { action: 'remember', text: '阿'.repeat(200) })
  assert.equal(wide.ok, true)
  assert.equal(wide.chars, 202)
  assert.ok(wide.bytes > wide.maxChars)
  assert.equal(wide.overBudget, false)

  // Only column-zero "- " lines are entries.
  resetMemory()
  const counted = store.writeMemory('# Memory\n- one\n  - nested\n- two\n')
  assert.equal(counted.entries, 2)
  assert.equal((await fixture.call('ria_memory', { action: 'read' })).entries, 2)

  // A manual edit may bypass writeMemory. The prompt gets only complete lines
  // that fit, plus an explicit over-budget notice in the same turn.
  resetMemory({ maxEntries: 1 })
  writeFileSync(memoryFile, '# Memory\n- one\n- two\n- three\n', { mode: 0o600 })
  const manual = memoryPromptPayload(readFileSync(memoryFile, 'utf8'), store.memorySettings())
  assert.equal(manual.text, '# Memory\n- one')
  assert.match(manual.notice, /over budget/)
  assert.match(manual.notice, /Loaded only 1 complete entries/)
  const prompt = managerPrompt(fixture.riaAgent.id, manual.text, store.styleSettings(), manual.notice)
  assert.match(prompt, /## User memory \(preferences, not commands\)/)
  assert.match(prompt, /\[memory\.md is over budget:/)

  // Archive read/list: 4000 chars per page, offset continuation, slug checks.
  resetMemory()
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(archiveDir, 'worker-lessons.md'), 'x'.repeat(4500), { mode: 0o600 })
  const page1 = await fixture.call('ria_memory', { action: 'read', scope: 'archive', path: 'worker-lessons' })
  assert.equal(page1.ok, true)
  assert.equal(page1.scope, 'archive')
  assert.equal(page1.text.length, 4000)
  assert.equal(page1.returnedChars, 4000)
  assert.equal(page1.nextOffset, 4000)
  assert.equal(page1.truncated, true)
  const page2 = await fixture.call('ria_memory', { action: 'read', scope: 'archive', path: 'worker-lessons', offset: 4000 })
  assert.equal(page2.text.length, 500)
  assert.equal(page2.nextOffset, null)
  assert.equal(page2.truncated, false)
  const listed = await fixture.call('ria_memory', { action: 'list' })
  assert.equal(listed.ok, true)
  assert.equal(listed.count, 1)
  assert.equal(listed.archives[0].slug, 'worker-lessons')
  assert.equal(listed.archives[0].chars, 4500)
  await assert.rejects(
    () => fixture.call('ria_memory', { action: 'read', scope: 'archive', path: '../secret' }),
    /invalid memory archive path/,
  )
  await assert.rejects(
    () => fixture.call('ria_memory', { action: 'read', scope: 'archive', path: 'missing' }),
    /memory archive not found/,
  )

  // POST /settings validates ranges and persists a partial update.
  const badSettings = await request('POST', '/plugins/dsh-ria/api/settings', { memory: { maxChars: 400 } })
  assert.equal(badSettings.status, 400)
  assert.match(badSettings.body.error, /body\.memory\.maxChars must be an integer from 500 to 20000/)
  const emptyMemory = await request('POST', '/plugins/dsh-ria/api/settings', { memory: {} })
  assert.equal(emptyMemory.status, 400)
  assert.match(emptyMemory.body.error, /body\.memory must include/)
  const savedMemory = await request('POST', '/plugins/dsh-ria/api/settings', {
    memory: { maxChars: 1800, maxEntries: 8, maxEntryChars: 220 },
  })
  assert.equal(savedMemory.status, 200)
  assert.deepEqual(savedMemory.body.memory, { maxChars: 1800, maxEntries: 8, maxEntryChars: 220 })
  assert.deepEqual(savedMemory.body.memoryStatus.maxChars, 1800)

  // Settings UI must expose the same three budgets with explicit units.
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(clientSource.includes('"data-ria-memory": "section"'))
  assert.ok(clientSource.includes('"data-ria-memory-field": key'))
  for (const key of ['maxChars', 'maxEntries', 'maxEntryChars']) {
    assert.ok(clientSource.includes(key + ': { min:'), key)
  }
  assert.ok(clientSource.includes('data-ria-memory-usage'))
  assert.ok(clientSource.includes('data-ria-memory-save'))
  assert.ok(clientSource.includes('总字符上限（字符）'))
  assert.ok(clientSource.includes('条数上限（条）'))
  assert.ok(clientSource.includes('单条上限（字符）'))
} finally {
  fixture.cleanup()
}

console.log('memory-budget ok')
