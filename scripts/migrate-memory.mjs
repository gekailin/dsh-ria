#!/usr/bin/env node
// One-shot migration of the legacy stateDir/memory.md into cognition/chat/.
//
// Usage:
//   node scripts/migrate-memory.mjs --state <stateDir> [--backup <dir>] [--dry-run]
//   node scripts/migrate-memory.mjs --restore <backupDir>
//
// Guarantees:
//   * timestamped backup of memory.md (and of the target if it existed)
//   * idempotent: a marker in cognition/chat/ stops a second migration
//   * non-destructive: an existing non-empty preferences.md is a conflict and is
//     never overwritten or reset; the old data stays in place
//   * rollback: --restore reverts the migrated target and removes the marker
//   * memory.md itself is kept; this script never deletes user data

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { writeAtomic } from '../lib/shared/fs.mjs'

const PREFERENCES = 'cognition/chat/preferences.md'
const MARKER = 'cognition/chat/.memory-migrated.json'

function parseArgs(argv) {
  const out = { state: '', backup: '', restore: '', dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--state') out.state = argv[++index] || ''
    else if (arg === '--backup') out.backup = argv[++index] || ''
    else if (arg === '--restore') out.restore = argv[++index] || ''
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/migrate-memory.mjs --state <dir> [--backup <dir>] [--dry-run]\n       node scripts/migrate-memory.mjs --restore <backupDir>\n')
      process.exit(0)
    } else {
      process.stderr.write('migrate-memory: unknown argument: ' + arg + '\n')
      process.exit(1)
    }
  }
  return out
}

const sha = text => createHash('sha256').update(String(text)).digest('hex')
const trim = text => String(text == null ? '' : text).trim()
const isEmptyPreferences = text => trim(text).replace(/^#\s*Preferences\s*/i, '').trim() === ''

function plan(stateDir) {
  const sourceFile = join(stateDir, 'memory.md')
  const targetFile = join(stateDir, PREFERENCES)
  const markerFile = join(stateDir, MARKER)
  if (existsSync(markerFile)) return { changed: false, reason: 'already-migrated', sourceFile, targetFile, markerFile }
  if (!existsSync(sourceFile) || !trim(readFileSync(sourceFile, 'utf8'))) {
    return { changed: false, reason: 'no-memory', sourceFile, targetFile, markerFile }
  }
  const source = readFileSync(sourceFile, 'utf8')
  const targetExists = existsSync(targetFile)
  const targetBefore = targetExists ? readFileSync(targetFile, 'utf8') : null
  if (targetExists && !isEmptyPreferences(targetBefore)) {
    return { changed: false, reason: 'conflict', sourceFile, targetFile, markerFile, targetBefore, source }
  }
  const content = '# Preferences\n\n' + trim(source) + '\n'
  return { changed: true, sourceFile, targetFile, markerFile, targetBefore, targetExists, content, source }
}

function backup(planValue, backupRoot) {
  const dir = join(resolve(backupRoot), 'memory-migration-' + new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  copyFileSync(planValue.sourceFile, join(dir, 'memory.md'))
  if (planValue.targetExists) copyFileSync(planValue.targetFile, join(dir, 'preferences.before.md'))
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    stateDir: resolve(dirname(planValue.sourceFile)),
    source: planValue.sourceFile,
    target: planValue.targetFile,
    marker: planValue.markerFile,
    targetBefore: planValue.targetBefore,
    migratedSha: sha(planValue.content),
    backupDir: dir,
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  return dir
}

function restore(backupDir) {
  const dir = resolve(backupDir)
  const manifestFile = join(dir, 'manifest.json')
  if (!existsSync(manifestFile)) {
    process.stderr.write('migrate-memory: not a migration backup (manifest.json missing): ' + dir + '\n')
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const targetFile = resolve(manifest.target)
  if (!existsSync(targetFile)) {
    process.stderr.write('migrate-memory: migrated target is gone, nothing to roll back: ' + targetFile + '\n')
    process.exit(1)
  }
  if (sha(readFileSync(targetFile, 'utf8')) !== manifest.migratedSha) {
    process.stderr.write('migrate-memory: target changed after the migration; refusing to overwrite it. Restore manually from ' + dir + '\n')
    process.exit(1)
  }
  if (manifest.targetBefore === null || manifest.targetBefore === undefined) {
    unlinkSync(targetFile)
  } else {
    writeAtomic(targetFile, manifest.targetBefore)
  }
  if (existsSync(manifest.marker)) unlinkSync(manifest.marker)
  process.stdout.write(JSON.stringify({ restored: true, backupDir: dir, target: targetFile }, null, 2) + '\n')
}

const args = parseArgs(process.argv.slice(2))
if (args.restore) {
  restore(args.restore)
  process.exit(0)
}
if (!args.state) {
  process.stderr.write('migrate-memory: --state is required\n')
  process.exit(1)
}
const stateDir = resolve(args.state)
if (!existsSync(stateDir) || !statSync(stateDir).isDirectory()) {
  process.stderr.write('migrate-memory: state dir does not exist: ' + stateDir + '\n')
  process.exit(1)
}
const value = plan(stateDir)
if (args.dryRun) {
  process.stdout.write(JSON.stringify({ dryRun: true, stateDir, plan: { changed: value.changed, reason: value.reason || null } }, null, 2) + '\n')
  process.exit(0)
}
if (!value.changed) {
  process.stdout.write(JSON.stringify({ stateDir, changed: false, reason: value.reason, backupDir: null }, null, 2) + '\n')
  process.exit(0)
}
const backupDir = backup(value, args.backup || join(stateDir, 'memory-migration-backups'))
mkdirSync(dirname(value.targetFile), { recursive: true, mode: 0o700 })
writeAtomic(value.targetFile, value.content)
writeFileSync(value.markerFile, JSON.stringify({
  version: 1,
  migratedAt: new Date().toISOString(),
  source: value.sourceFile,
  target: value.targetFile,
  backupDir,
  migratedSha: sha(value.content),
}, null, 2) + '\n', { mode: 0o600 })
process.stdout.write(JSON.stringify({ stateDir, changed: true, backupDir, target: value.targetFile }, null, 2) + '\n')
