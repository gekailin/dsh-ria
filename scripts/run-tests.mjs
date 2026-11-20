#!/usr/bin/env node
// Auto-discover and run every test/*.mjs file.
//
// The old package.json command was a hand-maintained chain: a new test could be
// written and silently never run (state-resume-inbox.mjs was missing). This runner
// scans the directory, runs each file as its own Node process, and fails the
// whole run if any test fails.

import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const testDir = join(root, 'test')
const filter = process.argv[2] ? String(process.argv[2]) : ''
const files = readdirSync(testDir)
  .filter(name => name.endsWith('.mjs'))
  .filter(name => !filter || name.includes(filter))
  .filter(name => {
    try { return statSync(join(testDir, name)).isFile() } catch { return false }
  })
  .sort()

if (!files.length) {
  console.error('run-tests: no test/*.mjs files matched' + (filter ? ' filter ' + filter : ''))
  process.exit(1)
}

const startedAt = Date.now()
const failures = []
let passed = 0
for (const name of files) {
  const file = 'test/' + name
  process.stdout.write('RUN  ' + file + ' ... ')
  const result = spawnSync(process.execPath, [file], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  })
  if (result.status === 0) {
    passed += 1
    process.stdout.write('PASS\n')
    continue
  }
  failures.push({ file, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '' })
  process.stdout.write('FAIL\n')
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log('')
if (failures.length) {
  for (const failure of failures) {
    console.error('=== FAIL ' + failure.file + ' (exit=' + failure.status + (failure.signal ? ', signal=' + failure.signal : '') + ') ===')
    const output = (failure.stdout + failure.stderr).trim()
    console.error(output.split('\n').slice(-40).join('\n'))
    console.error('')
  }
  console.error('run-tests: ' + passed + ' passed, ' + failures.length + ' failed, ' + files.length + ' total (' + elapsed + 's)')
  process.exit(1)
}
console.log('run-tests: ' + passed + ' passed, 0 failed, ' + files.length + ' total (' + elapsed + 's)')
