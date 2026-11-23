import { join } from 'node:path'
import { writeAtomic } from '../atomic-file.mjs'
import { cloneState } from '../snapshot.mjs'

/** Single authority rule: tickets, ticket metadata and archive closures come
 * from one DB snapshot. Only non-ticket domain fields (settings/executors/
 * reports/WorkOrders/etc.) are overlaid from the current committed in-memory
 * state. No JSON ticket/meta value participates, regardless of its timestamp.
 * Ticket meta has DB-assigned metaRevision/monotonic updatedAt for stale-write
 * checks; mirror generation fences whole-file publication across newer writes.
 */
export function buildMirrorSnapshot({ records, counts, ria = {}, state = {}, generation = 0 }) {
  const hot = records.filter(record => record.archivedAt === null)
  const meta = Object.fromEntries(records.filter(record => record.meta != null)
    .map(record => [record.ticket.ticketId, cloneState(record.meta)]))
  const archives = new Map()
  for (const record of records) {
    const history = [...(record.archiveRecords || [])]
    if (record.archivedAt !== null && !history.some(item => item.ticket?.ticketId === record.ticket.ticketId
      && item.closedAt === (record.ticket.closedAt || record.archivedAt))) {
      history.push({ ticket: record.ticket, ticketId: record.ticket.ticketId,
        closedAt: record.ticket.closedAt || record.archivedAt, schema: 1 })
    }
    for (const item of history) {
      if (!item?.ticket?.ticketId) continue
      const key = JSON.stringify([item.ticket.ticketId, item.closedAt || item.ticket.closedAt || 0])
      archives.set(key, cloneState(item))
    }
  }
  return {
    generation,
    ria: { ...cloneState(ria), tickets: hot.map(record => cloneState(record.ticket)) },
    state: { ...cloneState(state) },
    archives: [...archives.values()].sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0)),
    counts: cloneState(counts),
  }
}

export function mirrorSuperseded() {
  return Object.assign(new Error('Mirror snapshot superseded by a newer committed generation'), { code: 'mirror_superseded' })
}

/** Each file replacement is atomic, not a cross-file transaction. The runtime
 * acknowledges the DB generation only after every file is published; any crash
 * or partial failure remains dirty and retries the complete snapshot. ria.json
 * is written last so an offline rollback switches storage only after sidecars.
 */
export function writeMirrorSnapshot({ stateDir, snapshot, storage = 'sqlite', isCurrent = () => true, write = writeAtomic, writeRia = false }) {
  const assertCurrent = () => { if (!isCurrent()) throw mirrorSuperseded() }
  const marker = { generation: snapshot.generation }
  const publish = (name, content) => {
    assertCurrent()
    write(join(stateDir, name), content, { beforeRename: assertCurrent })
    assertCurrent()
  }
  const statePayload = { ...snapshot.state }
  delete statePayload.tickets
  delete statePayload.ticketMirror
  publish('state.json', JSON.stringify(statePayload, null, 2) + '\n')
  // An empty DB archive must replace a stale JSON archive, not leave it behind.
  publish('tickets.log.jsonl', snapshot.archives.map(record => JSON.stringify(record)).join('\n') + (snapshot.archives.length ? '\n' : ''))
  // Phase A: the live mirror no longer writes ria.json. The explicit offline
  // export/rollback path opts in with writeRia=true.
  if (writeRia) publish('ria.json', JSON.stringify({ ...snapshot.ria, storage, ticketMirror: marker }, null, 2) + '\n')
  return true
}
