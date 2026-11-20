#!/usr/bin/env node
// One-shot migration of legacy Project/Topic records.
//
// Usage:
//   node scripts/migrate-topics.mjs --state <stateDir> [--backup <dir>] [--dry-run]
//   node scripts/migrate-topics.mjs --restore <backupDir>
//
// The old model stored level/parentId as a tree. The target model is the
// two-level Project (nullable) / Topic with projectKey + tags. This migration:
//   * derives each topic's projectKey from its own or an ancestor's
//     projectKey/projectCwd/cwd/workspace/path hint;
//   * falls back to projectKey=null when no hint exists;
//   * drops level/parentId and defaults tags to [];
//   * backs up ria.json first, is idempotent and supports --restore.
//
// Topics live in ria.json; the script never touches the SQLite ticket database.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { projectKey as deriveProjectKey } from '../lib/v2/cognition.mjs'
import { normalizeProjectKey, normalizeTopicTags } from '../lib/topics.mjs'
import { writeAtomic } from '../lib/shared/fs.mjs'

const STATE_FILE = 'ria.json'
const sha = text => createHash('sha256').update(String(text)).digest('hex')
const text = value => typeof value === 'string' ? value.trim() : ''

function parseArgs(argv) {
  const out = { state: '', backup: '', restore: '', dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--state') out.state = argv[++index] || ''
    else if (arg === '--backup') out.backup = argv[++index] || ''
    else if (arg === '--restore') out.restore = argv[++index] || ''
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/migrate-topics.mjs --state <dir> [--backup <dir>] [--dry-run]\n       node scripts/migrate-topics.mjs --restore <backupDir>\n')
      process.exit(0)
    } else {
      process.stderr.write('migrate-topics: unknown argument: ' + arg + '\n')
      process.exit(1)
    }
  }
  return out
}

function projectKeyFor(topic, byId) {
  const own = normalizeProjectKey(topic.projectKey)
  if (own) return own
  const seen = new Set()
  let cursor = topic
  while (cursor && typeof cursor === 'object') {
    if (seen.has(cursor.topicId)) break
    seen.add(cursor.topicId)
    const hint = normalizeProjectKey(cursor.projectKey)
    if (hint) return hint
    for (const field of ['projectCwd', 'cwd', 'workspace', 'path']) {
      const value = text(cursor[field])
      if (!value) continue
      try { return deriveProjectKey(value) } catch { /* keep walking */ }
    }
    cursor = cursor.parentId ? byId.get(String(cursor.parentId)) : null
  }
  return null
}

function plan(stateDir) {
  const file = join(stateDir, STATE_FILE)
  if (!existsSync(file)) return { changed: false, reason: 'no-state', file }
  let data
  try { data = JSON.parse(readFileSync(file, 'utf8')) }
  catch { return { changed: false, reason: 'state-not-json', file } }
  const topics = Array.isArray(data && data.topics) ? data.topics : []
  if (!topics.length) return { changed: false, reason: 'no-topics', file }
  const byId = new Map(topics.map(topic => [String(topic.topicId), topic]))
  let changes = 0
  const migrated = topics.map(topic => {
    const next = { ...topic }
    const projectKey = projectKeyFor(topic, byId)
    const tags = normalizeTopicTags(topic.tags)
    if (next.projectKey !== projectKey) { next.projectKey = projectKey; changes += 1 }
    if (!Array.isArray(next.tags) || JSON.stringify(next.tags) !== JSON.stringify(tags)) { next.tags = tags; changes += 1 }
    if ('level' in next) { delete next.level; changes += 1 }
    if ('parentId' in next) { delete next.parentId; changes += 1 }
    return next
  })
  if (!changes) return { changed: false, reason: 'already-migrated', file, data }
  data.topics = migrated
  const serialized = JSON.stringify(data, null, 2) + '\n'
  return { changed: true, file, data, serialized, changes }
}

function backup(value, backupRoot) {
  const dir = join(resolve(backupRoot), 'topics-migration-' + new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  copyFileSync(value.file, join(dir, STATE_FILE))
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    stateDir: resolve(join(value.file, '..')),
    file: value.file,
    changes: value.changes,
    migratedSha: sha(value.serialized),
    backupDir: dir,
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  return dir
}

function restore(backupDir) {
  const dir = resolve(backupDir)
  const manifestFile = join(dir, 'manifest.json')
  if (!existsSync(manifestFile)) {
    process.stderr.write('migrate-topics: not a migration backup (manifest.json missing): ' + dir + '\n')
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const target = resolve(manifest.file)
  if (existsSync(target) && sha(readFileSync(target, 'utf8')) !== manifest.migratedSha) {
    process.stderr.write('migrate-topics: ria.json changed after the migration; refusing to overwrite. Restore manually from ' + join(dir, STATE_FILE) + '\n')
    process.exit(1)
  }
  copyFileSync(join(dir, STATE_FILE), target)
  process.stdout.write(JSON.stringify({ restored: true, backupDir: dir, file: target }, null, 2) + '\n')
}

const args = parseArgs(process.argv.slice(2))
if (args.restore) {
  restore(args.restore)
  process.exit(0)
}
if (!args.state) {
  process.stderr.write('migrate-topics: --state is required\n')
  process.exit(1)
}
const stateDir = resolve(args.state)
if (!existsSync(stateDir)) {
  process.stderr.write('migrate-topics: state dir does not exist: ' + stateDir + '\n')
  process.exit(1)
}
const value = plan(stateDir)
if (args.dryRun) {
  process.stdout.write(JSON.stringify({ dryRun: true, stateDir, plan: { changed: value.changed, reason: value.reason || null, changes: value.changes || 0 } }, null, 2) + '\n')
  process.exit(0)
}
if (!value.changed) {
  process.stdout.write(JSON.stringify({ stateDir, changed: false, reason: value.reason, backupDir: null }, null, 2) + '\n')
  process.exit(0)
}
const backupDir = backup(value, args.backup || join(stateDir, 'topics-migration-backups'))
writeAtomic(value.file, value.serialized)
process.stdout.write(JSON.stringify({ stateDir, changed: true, changes: value.changes, backupDir }, null, 2) + '\n')
