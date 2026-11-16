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

  // A rejected write returns every number the model needs, not just a code.
  resetMemory({ maxChars: 500, maxEntries: 2, maxEntryChars: 50 })
  writeFileSync(memoryFile, '- one\n- **long**: ' + 'a'.repeat(60) + '\n', { mode: 0o600 })
  const beforeReject = store.readMemory()
  const rejected = await fixture.call('ria_memory', { action: 'remember', key: 'new', text: 'x' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'memory_over_budget')
  assert.match(rejected.message, /3\/2 entries \(\+1\)/)
  assert.match(rejected.message, /Longest entry "long": \d+\/50 chars \(\+\d+\)/)
  assert.match(rejected.message, /Over-limit entries: "long" \d+\/50 chars \(\+\d+\)/)
  assert.match(rejected.message, /No changes were made\./)
  assert.equal(rejected.error, rejected.message)
  assert.equal(rejected.diagnostics.entries, 3)
  assert.equal(rejected.diagnostics.maxEntries, 2)
  assert.deepEqual(rejected.diagnostics.overEntryKeys, ['long'])
  assert.equal(rejected.diagnostics.overEntryDetails[0].key, 'long')
  assert.equal(store.readMemory(), beforeReject)

  // Each hard limit rejects the whole write and leaves the file untouched.
  resetMemory({ maxChars: 500, maxEntryChars: 2000 })
  const tooManyChars = await fixture.call('ria_memory', { action: 'remember', text: 'a'.repeat(500) })
  assert.equal(tooManyChars.ok, false)
  assert.match(tooManyChars.message, /502\/500 chars \(\+2\)/)
  assert.match(tooManyChars.message, /total only/)
  assert.match(tooManyChars.message, /No changes were made\./)
  assert.equal(tooManyChars.diagnostics.totalOnly, true)
  assert.equal(store.readMemory(), '')

  resetMemory({ maxEntries: 1 })
  await fixture.call('ria_memory', { action: 'remember', key: 'one', text: 'x' })
  const oneEntry = store.readMemory()
  const tooManyEntries = await fixture.call('ria_memory', { action: 'remember', key: 'two', text: 'y' })
  assert.equal(tooManyEntries.ok, false)
  assert.match(tooManyEntries.message, /2\/1 entries \(\+1\)/)
  assert.match(tooManyEntries.message, /No changes were made\./)
  assert.equal(store.readMemory(), oneEntry)

  resetMemory({ maxEntryChars: 50 })
  const tooLongEntry = await fixture.call('ria_memory', { action: 'remember', text: 'a'.repeat(60) })
  assert.equal(tooLongEntry.ok, false)
  assert.match(tooLongEntry.message, /1 entry over 50 chars/)
  assert.match(tooLongEntry.message, /Longest entry \(unnamed\): 62\/50 chars \(\+12\)/)
  assert.match(tooLongEntry.message, /Over-limit entries: "\(unnamed\)" 62\/50 chars \(\+12\)/)
  assert.match(tooLongEntry.message, /No changes were made\./)
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

  // action=replace writes the whole core atomically; content is verbatim.
  resetMemory()
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(archiveDir, 'worker-lessons.md'), 'detail stays here\n', { mode: 0o600 })
  const contentReplace = await fixture.call('ria_memory', {
    action: 'replace',
    content: '# Memory\n- one\n- two\n',
  })
  assert.equal(contentReplace.ok, true)
  assert.equal(contentReplace.action, 'replace')
  assert.equal(contentReplace.entries, 2)
  assert.equal(contentReplace.text, undefined)
  assert.equal(store.readMemory(), '# Memory\n- one\n- two\n')
  assert.equal(contentReplace.archives[0].slug, 'worker-lessons')

  // entries=[...] is the other replacement shape; each item becomes one bullet.
  const entriesReplace = await fixture.call('ria_memory', {
    action: 'replace',
    entries: [{ key: 'name', text: '阿汐' }, { text: '中文，先结论' }],
  })
  assert.equal(entriesReplace.ok, true)
  assert.equal(entriesReplace.entries, 2)
  assert.equal(store.readMemory(), '- **name**: 阿汐\n- 中文，先结论\n')
  assert.equal((await fixture.call('ria_memory', { action: 'read', scope: 'archive', path: 'worker-lessons' })).text, 'detail stays here\n')

  // Any over-budget replacement rejects every entry and leaves the old file.
  resetMemory({ maxEntries: 2 })
  writeFileSync(memoryFile, 'BEFORE\n', { mode: 0o600 })
  const tooManyReplaced = await fixture.call('ria_memory', {
    action: 'replace',
    entries: [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
  })
  assert.equal(tooManyReplaced.ok, false)
  assert.equal(tooManyReplaced.code, 'memory_over_budget')
  assert.match(tooManyReplaced.message, /3\/2 entries \(\+1\)/)
  assert.equal(tooManyReplaced.diagnostics.overEntries, 1)
  assert.equal(store.readMemory(), 'BEFORE\n')

  resetMemory({ maxEntryChars: 50 })
  writeFileSync(memoryFile, 'BEFORE\n', { mode: 0o600 })
  const longLine = '- **long**: ' + 'a'.repeat(60)
  const overlongReplaced = await fixture.call('ria_memory', {
    action: 'replace',
    entries: [{ key: 'long', text: 'a'.repeat(60) }],
  })
  assert.equal(overlongReplaced.ok, false)
  assert.equal(overlongReplaced.diagnostics.longestEntryKey, 'long')
  assert.equal(overlongReplaced.diagnostics.overEntryDetails[0].key, 'long')
  assert.equal(overlongReplaced.diagnostics.overEntryDetails[0].chars, measureText(longLine).chars)
  assert.match(overlongReplaced.message, /Over-limit entries: "long" \d+\/50 chars \(\+\d+\)/)
  assert.equal(store.readMemory(), 'BEFORE\n')

  resetMemory({ maxChars: 500, maxEntryChars: 2000 })
  writeFileSync(memoryFile, 'BEFORE\n', { mode: 0o600 })
  const totalReplaced = await fixture.call('ria_memory', { action: 'replace', content: 'a'.repeat(600) })
  assert.equal(totalReplaced.ok, false)
  assert.match(totalReplaced.message, /600\/500 chars \(\+100\)/)
  assert.match(totalReplaced.message, /total only/)
  assert.equal(totalReplaced.diagnostics.totalOnly, true)
  assert.equal(store.readMemory(), 'BEFORE\n')

  // Invalid replacement payloads are rejected before any write.
  const bothShapes = await fixture.call('ria_memory', { action: 'replace', content: 'x', entries: [] })
  assert.equal(bothShapes.code, 'invalid_argument')
  const noShape = await fixture.call('ria_memory', { action: 'replace' })
  assert.equal(noShape.code, 'invalid_argument')
  const multiline = await fixture.call('ria_memory', { action: 'replace', entries: [{ text: 'a\nb' }] })
  assert.equal(multiline.code, 'invalid_argument')
  assert.equal(store.readMemory(), 'BEFORE\n')

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

  // POST /settings validates ranges and persists a partial update. Saving only
  // maxEntries must not clear or rewrite maxChars / maxEntryChars.
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
  const onlyEntries = await request('POST', '/plugins/dsh-ria/api/settings', { memory: { maxEntries: 9 } })
  assert.equal(onlyEntries.status, 200)
  assert.deepEqual(onlyEntries.body.memory, { maxChars: 1800, maxEntries: 9, maxEntryChars: 220 })
  assert.equal(onlyEntries.body.memoryStatus.maxChars, 1800)
  assert.equal(onlyEntries.body.memoryStatus.maxEntryChars, 220)

  // Settings UI exposes exactly one editable field. The helper block is plain
  // browser code, so evaluate it directly instead of grepping the rendered JSX.
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const blockStart = clientSource.indexOf('/* memory-budget:start */')
  const blockEnd = clientSource.indexOf('/* memory-budget:end */')
  assert.ok(blockStart >= 0 && blockEnd > blockStart)
  const memoryUi = new Function(clientSource.slice(blockStart, blockEnd) +
    '\nreturn { MEMORY_UI_DEFAULTS, MEMORY_UI_FIELDS, MEMORY_UI_RANGES, memoryDraftFrom, memoryDraftValues, memoryDraftDirty };')()
  assert.deepEqual(memoryUi.MEMORY_UI_FIELDS, ['maxEntries'])
  assert.deepEqual(Object.keys(memoryUi.MEMORY_UI_RANGES), ['maxEntries'])
  assert.deepEqual(memoryUi.memoryDraftFrom({ maxChars: 1800, maxEntries: 9, maxEntryChars: 220 }), { maxEntries: '9' })
  assert.deepEqual(memoryUi.memoryDraftValues({ maxEntries: '8' }), { values: { maxEntries: 8 } })
  assert.deepEqual(memoryUi.memoryDraftValues({ maxEntries: '8', maxChars: '', maxEntryChars: '' }), { values: { maxEntries: 8 } })
  assert.match(memoryUi.memoryDraftValues({ maxEntries: '0' }).error, /条数上限/)
  assert.equal(memoryUi.memoryDraftDirty({ maxEntries: '8' }, { maxEntries: 12 }), true)
  assert.equal(memoryUi.memoryDraftDirty({ maxEntries: '12' }, { maxEntries: 12 }), false)
  assert.ok(clientSource.includes('MEMORY_UI_FIELDS.map(function (key)'))
  assert.ok(!clientSource.includes('Object.keys(MEMORY_UI_RANGES).map'))
  assert.ok(clientSource.includes('data-ria-memory-field'))
  assert.ok(clientSource.includes('data-ria-memory-save'))
  assert.ok(clientSource.includes('条数上限（条）'))
  assert.ok(!clientSource.includes('总字符上限（字符）'))
  assert.ok(!clientSource.includes('单条上限（字符）'))
} finally {
  fixture.cleanup()
}

console.log('memory-budget ok')
