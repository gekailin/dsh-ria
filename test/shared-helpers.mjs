import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { ensureDir, readJsonSafe, writeJsonAtomic } from '../lib/shared/fs.mjs'
import { clip, imageMediaType, measureText } from '../lib/shared/text.mjs'

assert.equal(clip('abcdef', 3), 'abc…')
assert.equal(clip('abcdef', 6), 'abcdef')
assert.equal(clip('😀😀😀', 2, '!'), '😀😀!')
assert.equal(clip(null, 2), '')
assert.deepEqual(measureText('ab'), { chars: 2, bytes: 2 })
assert.equal(imageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
assert.equal(imageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
assert.equal(imageMediaType(Buffer.from('GIF89a')), 'image/gif')
assert.equal(imageMediaType(Buffer.from('RIFFxxxxWEBP')), 'image/webp')
assert.equal(imageMediaType(Buffer.from('not an image')), null)

const dir = fs.mkdtempSync(join(os.tmpdir(), 'ria-shared-'))
try {
  ensureDir(join(dir, 'nested'))
  assert.equal(fs.statSync(join(dir, 'nested')).isDirectory(), true)
  const file = join(dir, 'state.json')
  writeJsonAtomic(file, { ok: true, n: 1 })
  assert.deepEqual(readJsonSafe(file), { ok: true, n: 1 })
  fs.writeFileSync(file, '{broken')
  assert.deepEqual(readJsonSafe(file, { fallback: true }), { fallback: true })
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('shared-helpers: ok')
