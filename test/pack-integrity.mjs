import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cache = mkdtempSync(join(tmpdir(), 'ria-pack-cache-'))
let pack
try {
  pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    env: { ...process.env, npm_config_cache: cache },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
} finally {
  rmSync(cache, { recursive: true, force: true })
}
const packed = new Set((pack[0] && pack[0].files ? pack[0].files : []).map(item => item.path))

// 1) every first-level lib directory has at least one file in the package.
const libDirs = readdirSync(join(root, 'lib'), { withFileTypes: true })
  .filter(item => item.isDirectory())
  .map(item => item.name)
  .sort()
for (const dir of libDirs) {
  assert.ok([...packed].some(path => path.startsWith('lib/' + dir + '/')), 'packed lib/' + dir + '/ is missing')
}

// 2) every file under lib/prompts is packed (not just the directory entry).
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(item => {
  const full = join(dir, item.name)
  return item.isDirectory() ? walk(full) : [relative(root, full)]
})
const prompts = walk(join(root, 'lib', 'prompts')).sort()
assert.ok(prompts.length > 0, 'lib/prompts is empty on disk')
for (const file of prompts) assert.ok(packed.has(file), 'packed file missing: ' + file)

// 3) lib/index.js and every static relative import it makes are packed.
assert.ok(packed.has('lib/index.js'), 'packed lib/index.js is missing')
const indexFile = join(root, 'lib', 'index.js')
const source = readFileSync(indexFile, 'utf8')
const imports = [...source.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)].map(match => match[1])
assert.ok(imports.length > 0, 'no static imports found in lib/index.js')
for (const spec of imports) {
  const target = relative(root, join(dirname(indexFile), spec))
  assert.ok(packed.has(target), 'static import not packed: ' + spec + ' -> ' + target)
}
console.log('pack integrity ok: ' + packed.size + ' files, ' + libDirs.length + ' lib dirs, ' + prompts.length + ' prompts, ' + imports.length + ' imports')
