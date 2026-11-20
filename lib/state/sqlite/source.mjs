import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const sha256 = raw => createHash('sha256').update(raw).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const fail = message => Object.assign(new Error(message), { code: 'invalid_migration_source' })

export function readStateSource(stateDir) {
  const names = ['ria.json', 'v2.json', 'outbox.json', ...readdirSync(stateDir).filter(name => /^(tickets|tasks)([.-].*)?\.jsonl$/.test(name))]
    .filter((name, index, all) => all.indexOf(name) === index && existsSync(join(stateDir, name))).sort()
  if (!names.includes('ria.json')) throw fail('ria.json is required; run this check against an offline/maintenance snapshot')
  const files = names.map(name => {
    const raw = readFileSync(join(stateDir, name))
    return { name, bytes: raw.length, sha256: sha256(raw), raw }
  })
  const parseFile = (name, fallback) => {
    const file = files.find(item => item.name === name)
    if (!file) return fallback
    return JSON.parse(file.raw.toString('utf8'))
  }
  const ria = parseFile('ria.json', {})
  const v2 = parseFile('v2.json', {})
  if (!Array.isArray(ria.tickets)) throw fail('ria.json.tickets must be an array (upgrade old JSON schema first)')
  const records = new Map()
  const archives = new Map()
  for (const file of files.filter(item => item.name.endsWith('.jsonl'))) {
    const lines = file.raw.toString('utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].trim()) continue
      let record
      try { record = JSON.parse(lines[i]) } catch { throw fail('Invalid JSONL at ' + file.name + ':' + (i + 1) + '; repair the archive before verification') }
      if (!record.ticket || typeof record.ticket.ticketId !== 'string') throw fail('Missing archive ticket at ' + file.name + ':' + (i + 1))
      const id = record.ticket.ticketId
      const closedAt = record.closedAt || record.ticket.closedAt || 0
      const key = id + '\u0000' + closedAt
      // The hot/general/monthly archives can duplicate a closure. Keep it once.
      if (!archives.has(key)) archives.set(key, clone(record))
      const previous = records.get(id)
      if (!previous || closedAt >= (previous.archivedAt || 0)) {
        records.set(id, { ticket: clone(record.ticket), archivedAt: closedAt, meta: clone(v2.tickets?.[id] || null) })
      }
    }
  }
  const hotIds = new Set()
  for (const ticket of ria.tickets) {
    if (!ticket || typeof ticket.ticketId !== 'string' || !ticket.ticketId || hotIds.has(ticket.ticketId)) throw fail('Invalid/duplicate hot ticket id')
    hotIds.add(ticket.ticketId)
    records.set(ticket.ticketId, { ticket: clone(ticket), archivedAt: null, meta: clone(v2.tickets?.[ticket.ticketId] || null) })
  }
  for (const [id, record] of records) record.archiveRecords = [...archives.values()].filter(item => item.ticket.ticketId === id)
  const list = [...records.values()]
  const counts = {
    tickets: list.length,
    history: list.reduce((sum, record) => sum + (Array.isArray(record.ticket.history) ? record.ticket.history.length : 0), 0),
    hot: hotIds.size, archived: list.length - hotIds.size,
    meta: list.filter(record => record.meta !== null).length,
  }
  const sourceSha256 = sha256(files.map(({ name, sha256 }) => name + '\u0000' + sha256).join('\n'))
  return { records: list, ria, v2, counts, files, sourceSha256, importId: 'import_' + sourceSha256 }
}

export { sha256 }
