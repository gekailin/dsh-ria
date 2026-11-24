import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir } from '../shared/fs.mjs'

export const EVENT_LIMITS = Object.freeze({ requests: 500, reports: 500, workOrders: 500, ticketFeedback: 500, inbox: Infinity })
const CURRENT = 'events.jsonl'
const ARCHIVE = /^events-\d{8}T\d{6}\.jsonl$/

const clone = value => JSON.parse(JSON.stringify(value))
const idOf = (kind, item) => kind === 'request' ? item.requestId
  : kind === 'workorder' ? item.ticketId
    : kind === 'report' ? item.reportId
      : kind === 'inbox' ? item.id
        : kind === 'feedback' ? item.feedbackId
          : item.id

export class EventLog {
  constructor({ stateDir, maxBytes = 50 * 1024 * 1024, retainDays = 14, now = Date.now, warn = () => {} }) {
    this.stateDir = stateDir
    this.path = join(stateDir, CURRENT)
    this.maxBytes = maxBytes
    this.retainDays = retainDays
    this.now = now
    this.warn = warn
    ensureDir(stateDir)
    this.prune()
  }

  append(event) {
    const row = { at: Number.isFinite(event.at) ? event.at : this.now(), kind: String(event.kind), ticketId: event.ticketId == null ? null : String(event.ticketId), payload: event.payload }
    try {
      appendFileSync(this.path, JSON.stringify(row) + '\n', 'utf8')
      if (statSync(this.path).size >= this.maxBytes) this.rotate()
      return true
    } catch (error) {
      this.warn('events.jsonl append failed: ' + String(error && error.message ? error.message : error))
      return false
    }
  }

  rotate() {
    try {
      const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
      renameSync(this.path, join(this.stateDir, 'events-' + stamp + '.jsonl'))
    } catch (error) { this.warn('events.jsonl rotate failed: ' + String(error && error.message ? error.message : error)) }
  }

  prune() {
    const cutoff = this.now() - this.retainDays * 24 * 60 * 60 * 1000
    try {
      for (const name of readdirSync(this.stateDir)) {
        if (!ARCHIVE.test(name)) continue
        const path = join(this.stateDir, name)
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
      }
    } catch (error) { this.warn('events.jsonl retention failed: ' + String(error && error.message ? error.message : error)) }
  }

  hasEvents() {
    return existsSync(this.path) || (() => { try { return readdirSync(this.stateDir).some(name => ARCHIVE.test(name)) } catch { return false } })()
  }

  filesOldestFirst() {
    const files = []
    try {
      const archives = readdirSync(this.stateDir).filter(name => ARCHIVE.test(name)).map(name => join(this.stateDir, name))
        .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs || left.localeCompare(right))
      files.push(...archives)
      if (existsSync(this.path)) files.push(this.path)
    } catch { /* a missing directory is an empty log */ }
    return files
  }

  rebuild(limits = EVENT_LIMITS) {
    const data = { requests: {}, reports: [], workOrders: {}, inbox: [], ticketFeedback: [] }
    const arrays = { report: data.reports, inbox: data.inbox, feedback: data.ticketFeedback }
    let badLines = 0
    let read = 0
    for (const file of this.filesOldestFirst()) {
      let text = ''
      try { text = readFileSync(file, 'utf8') } catch { continue }
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        let event
        try { event = JSON.parse(line) } catch { badLines += 1; continue }
        if (!event || typeof event !== 'object' || typeof event.kind !== 'string') { badLines += 1; continue }
        read += 1
        const [kind, action] = event.kind.split('.')
        const payload = event.payload
        if (kind === 'request' || kind === 'workorder') {
          const map = kind === 'request' ? data.requests : data.workOrders
          const id = event.ticketId || (payload && idOf(kind, payload))
          if (id == null) continue
          if (action === 'removed') delete map[String(id)]
          else map[String(id)] = clone(payload)
        } else if (kind === 'report' || kind === 'inbox' || kind === 'feedback') {
          const list = arrays[kind]
          const id = payload && idOf(kind, payload)
          if (id == null) continue
          const index = list.findIndex(item => String(idOf(kind, item)) === String(id))
          if (action === 'removed') { if (index >= 0) list.splice(index, 1) }
          else if (index >= 0) list[index] = clone(payload)
          else list.push(clone(payload))
        }
      }
    }
    const trimMap = (map, limit) => Object.fromEntries(Object.entries(map).slice(-limit))
    data.requests = trimMap(data.requests, limits.requests ?? EVENT_LIMITS.requests)
    data.workOrders = trimMap(data.workOrders, limits.workOrders ?? EVENT_LIMITS.workOrders)
    const trimList = (list, limit) => Number.isFinite(limit) && limit > 0 ? list.slice(-limit) : list
    data.reports = trimList(data.reports, limits.reports ?? EVENT_LIMITS.reports)
    data.ticketFeedback = trimList(data.ticketFeedback, limits.ticketFeedback ?? EVENT_LIMITS.ticketFeedback)
    if (Number.isFinite(limits.inbox)) data.inbox = trimList(data.inbox, limits.inbox)
    return { data, badLines, read }
  }
}
