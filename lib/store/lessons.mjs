// DEPRECATED (B-2): lessons retired in favor of cognition/Sage proposals.
// Kept only as a legacy read helper; tools and dispatch no longer use it.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeAtomic } from '../shared/fs.mjs'
import { join } from 'node:path'

const SCHEMA_VERSION = 1
const MAX_ENTRIES = 500
const MAX_TEXT = 400
const CJK = /[\u4e00-\u9fff]/

const text = value => typeof value === 'string' ? value.trim() : ''
const clipped = (value, limit = MAX_TEXT) => {
  const body = text(value).replace(/\s+/g, ' ')
  return body.length > limit ? body.slice(0, limit) + '…' : body
}
const now = () => Date.now()

function asArray(value, limit = 20) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => text(item)).filter(Boolean))].slice(0, limit)
}

/**
 * Tokens are what the inverted index is built from: latin words plus CJK
 * bigrams, so a Chinese scenario is searchable without a dictionary.
 */
export function tokenize(value) {
  const tokens = new Set()
  const body = String(value == null ? '' : value).toLowerCase()
  for (const word of body.match(/[a-z0-9][a-z0-9_.#-]*/g) || []) {
    if (word.length >= 2) tokens.add(word)
  }
  for (const run of body.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return tokens
}

function slug(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function sourceOf(entry) {
  const source = entry && entry.source && typeof entry.source === 'object' ? entry.source : {}
  return { ticketId: text(source.ticketId), sessionId: text(source.sessionId) }
}

/**
 * Durable, searchable lessons learned. Unlike cognition/chat memory this is not injected
 * wholesale: the Advisor searches it per ticket and only matched entries are
 * rendered into the Executor brief.
 *
 * The whole file is small (hundreds of rows), but match() never iterates it:
 * an inverted index tag -> ids and token -> ids narrows the candidates first.
 */
export class LessonStore {
  constructor({ stateDir, log = () => {}, file = null, maxEntries = MAX_ENTRIES, runtime = null } = {}) {
    this.stateDir = stateDir
    this.file = file || join(stateDir, 'lessons.json')
    this.log = log
    this.maxEntries = maxEntries
    this.runtime = runtime
    this.data = { schemaVersion: SCHEMA_VERSION, entries: {} }
    this.tags = new Map()
    this.tokens = new Map()
    this.byDedupeKey = new Map()
    this.load()
  }

  load() {
    if (this.runtime) {
      try {
        const rows = this.runtime.readLessons()
        if (rows && rows.length) {
          this.data = { schemaVersion: SCHEMA_VERSION, entries: {} }
          for (const entry of rows) this.data.entries[entry.id] = this.normalize(entry)
          this.rebuildIndexes()
          return
        }
      } catch (error) { this.log('warn', 'could not read SQLite lessons: ' + String(error && error.message ? error.message : error)) }
    }
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        this.data = { schemaVersion: SCHEMA_VERSION, entries: {} }
        for (const [id, entry] of Object.entries(parsed.entries)) {
          if (!entry || typeof entry !== 'object') continue
          this.data.entries[id] = this.normalize({ ...entry, id })
        }
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') this.log('warn', 'could not read ' + this.file + ': ' + String(error.message || error))
    }
    this.rebuildIndexes()
  }

  save() {
    if (this.runtime) {
      try {
        this.runtime.writeLessons(Object.values(this.data.entries))
        return true
      } catch (error) {
        this.log('warn', 'could not write SQLite lessons: ' + String(error && error.message ? error.message : error))
        return false
      }
    }
    try {
      writeAtomic(this.file, JSON.stringify(this.data, null, 2) + '\n')
      return true
    } catch (error) {
      this.log('warn', 'could not write ' + this.file + ': ' + String(error && error.message ? error.message : error))
      return false
    }
  }

  normalize(raw) {
    const entry = {
      id: text(raw.id) || this.newId(),
      tags: asArray(raw.tags),
      condition: clipped(raw.condition),
      scenario: clipped(raw.scenario),
      pitfall: clipped(raw.pitfall),
      approach: clipped(raw.approach),
      source: sourceOf(raw),
      sources: Array.isArray(raw.sources)
        ? raw.sources.filter(item => item && typeof item === 'object').map(item => ({ ...sourceOf(item), at: Number.isFinite(item.at) ? item.at : 0 })).slice(-20)
        : [],
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now(),
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : (Number.isFinite(raw.createdAt) ? raw.createdAt : now()),
      hits: Number.isSafeInteger(raw.hits) && raw.hits >= 0 ? raw.hits : 0,
      status: raw.status === 'archived' ? 'archived' : 'active',
    }
    if (entry.source.ticketId || entry.source.sessionId) {
      entry.sources = entry.sources.filter(item => item.ticketId !== entry.source.ticketId || item.sessionId !== entry.source.sessionId)
      entry.sources.push({ ...entry.source, at: entry.createdAt })
    }
    return entry
  }

  rebuildIndexes() {
    this.tags = new Map()
    this.tokens = new Map()
    this.byDedupeKey = new Map()
    for (const entry of Object.values(this.data.entries)) {
      if (entry.status === 'active') this.index(entry)
      this.byDedupeKey.set(this.dedupeKey(entry), entry.id)
    }
  }

  index(entry) {
    for (const tag of entry.tags) {
      const key = tag.toLowerCase()
      if (!this.tags.has(key)) this.tags.set(key, new Set())
      this.tags.get(key).add(entry.id)
    }
    for (const token of tokenize([entry.scenario, entry.pitfall, entry.approach, entry.condition, entry.tags.join(' ')].join(' '))) {
      if (!this.tokens.has(token)) this.tokens.set(token, new Set())
      this.tokens.get(token).add(entry.id)
    }
  }

  newId() {
    return 'les_' + now().toString(36) + '_' + randomUUID().slice(0, 8)
  }

  get(id) {
    const entry = this.data.entries[String(id)]
    return entry ? { ...entry, tags: [...entry.tags] } : null
  }

  entries({ status = 'active' } = {}) {
    if (this.runtime) {
      return this.runtime.lessonEntries(status).map(entry => this.normalize(entry))
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
    }
    return Object.values(this.data.entries)
      .filter(entry => !status || entry.status === status)
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
  }

  list({ query = '', status = 'active', limit = 20 } = {}) {
    const max = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 20))
    const needle = text(query).toLowerCase()
    const base = this.entries({ status })
    const rows = needle
      ? base.filter(entry => [entry.scenario, entry.pitfall, entry.approach, entry.condition, entry.tags.join(' ')].join(' ').toLowerCase().includes(needle))
      : base
    return { lessons: rows.slice(0, max).map(entry => this.view(entry)), total: rows.length }
  }

  view(entry) {
    return {
      id: entry.id,
      tags: [...entry.tags],
      condition: entry.condition,
      scenario: entry.scenario,
      pitfall: entry.pitfall,
      approach: entry.approach,
      source: { ...entry.source },
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      hits: entry.hits,
      status: entry.status,
    }
  }

  dedupeKey(entry) {
    const scenario = slug(entry.scenario)
    const pitfall = slug(entry.pitfall)
    return createHash('sha1').update(scenario + '|' + pitfall).digest('hex').slice(0, 16)
  }

  merge(existing, incoming) {
    const source = sourceOf(incoming)
    const sources = Array.isArray(existing.sources) ? [...existing.sources] : []
    if (source.ticketId || source.sessionId) sources.push({ ...source, at: now() })
    existing.tags = [...new Set([...(existing.tags || []), ...(incoming.tags || [])])].slice(0, 20)
    existing.condition = clipped(incoming.condition) || existing.condition
    existing.approach = clipped(incoming.approach) || existing.approach
    existing.pitfall = clipped(incoming.pitfall) || existing.pitfall
    existing.source = source.ticketId || source.sessionId ? source : existing.source
    existing.sources = sources.slice(-20)
    existing.hits = (existing.hits || 0) + (incoming.hits || 0)
    existing.updatedAt = now()
    this.rebuildIndexes()
    this.save()
    return existing
  }

  /** Accept a reviewed candidate, merging into an existing entry when the scene+pitfall match. */
  accept(candidate) {
    const incoming = this.normalize(candidate)
    const key = this.dedupeKey(incoming)
    const existingId = this.byDedupeKey.get(key)
    const existing = existingId ? this.data.entries[existingId] : null
    if (existing) {
      const merged = this.merge(existing, incoming)
      return { entry: this.view(merged), deduped: true }
    }
    const entry = { ...incoming, id: this.newId(), createdAt: now(), updatedAt: now(), hits: incoming.hits || 0, status: 'active' }
    this.data.entries[entry.id] = entry
    this.byDedupeKey.set(key, entry.id)
    this.index(entry)
    this.prune()
    this.save()
    return { entry: this.view(entry), deduped: false }
  }

  add(raw) {
    return this.accept(raw)
  }

  prune() {
    const active = Object.values(this.data.entries).filter(entry => entry.status === 'active')
    if (active.length <= this.maxEntries) return
    const drop = active
      .sort((left, right) => (left.hits || 0) - (right.hits || 0) || (left.updatedAt || 0) - (right.updatedAt || 0))
      .slice(0, active.length - this.maxEntries)
    for (const entry of drop) entry.status = 'archived'
    this.rebuildIndexes()
  }

  bumpHits(ids) {
    const unique = asArray(ids)
    let changed = false
    for (const id of unique) {
      const entry = this.data.entries[String(id)]
      if (!entry) continue
      entry.hits = (entry.hits || 0) + 1
      entry.updatedAt = now()
      changed = true
    }
    if (changed) this.save()
  }

  /**
   * Rank active entries for a ticket. Only ids that appear in a queried tag or
   * token posting are scored, so the cost follows the match size, not the size
   * of the store. `scanned` is returned for callers (and tests) to observe it.
   */
  match({ goal = '', workspace = '', mode = '', limit = 3, maxChars = 800 } = {}) {
    if (this.runtime) this.load()
    const scores = new Map()
    const touched = new Set()
    const note = id => {
      if (!touched.has(id)) touched.add(id)
      return id
    }
    const bump = (id, amount) => scores.set(id, (scores.get(id) || 0) + amount)
    const tags = new Set()
    if (text(mode)) tags.add(text(mode).toLowerCase())
    for (const token of tokenize([goal, workspace, mode].join(' '))) {
      if (this.tags.has(token)) {
        tags.add(token)
        for (const id of this.tags.get(token)) { note(id); bump(id, 3) }
      }
      const posting = this.tokens.get(token)
      if (posting) for (const id of posting) { note(id); bump(id, 1) }
    }
    for (const tag of tags) {
      const posting = this.tags.get(tag)
      if (posting) for (const id of posting) { note(id); bump(id, 3) }
    }
    const ranked = [...scores.entries()]
      .map(([id, score]) => ({ entry: this.data.entries[id], score }))
      .filter(item => item.entry && item.entry.status === 'active')
      .sort((left, right) => right.score - left.score
        || (right.entry.hits || 0) - (left.entry.hits || 0)
        || (right.entry.updatedAt || 0) - (left.entry.updatedAt || 0))
    const selected = []
    let used = 0
    for (const item of ranked) {
      if (selected.length >= Math.max(1, Math.min(5, limit))) break
      const line = this.renderLine(item.entry)
      if (selected.length && used + line.length > maxChars) continue
      selected.push(this.view(item.entry))
      used += line.length
    }
    return { lessons: selected, scanned: touched.size, total: scores.size }
  }

  renderLine(entry) {
    return '- [' + entry.id + '] ' + clipped(entry.scenario, 60) + ' → ' + clipped(entry.pitfall, 60) + ' → ' + clipped(entry.approach, 60)
  }

  stats() {
    return { entries: Object.keys(this.data.entries).length, tags: this.tags.size, tokens: this.tokens.size }
  }
}
