import { join } from 'node:path'
import { writeAtomic } from '../atomic-file.mjs'
import { cloneState } from '../snapshot.mjs'

/** Single authority rule: tickets, ticket metadata and archive closures come
 * from one DB snapshot. Only non-ticket domain fields (settings/executors/
 * reports/WorkOrders/etc.) are overlaid from the current committed in-memory
 * state. No JSON ticket/meta value participates, regardless of its timestamp.
 * Ticket meta has DB-assigned metaRevision/monotonic updatedAt for stale-write
 * checks; the offline export is a one-shot snapshot, not a live state machine.
 */
export function buildMirrorSnapshot({ records, counts, ria = {}, state = {} }) {
  const hot = records.filter(record => record.archivedAt === null)
  const meta = Object.fromEntries(records.filter(record => record.meta != null)
    .map(record => [record.ticket.ticketId, cloneState(record.meta)]))
  const archives = new Map()
  for (const record of records) {
    if (record.archivedAt === null) continue
    const item = { ticket: record.ticket, ticketId: record.ticket.ticketId,
      closedAt: record.ticket.closedAt || record.archivedAt, schema: 1 }
    const key = JSON.stringify([item.ticketId, item.closedAt || 0])
    archives.set(key, cloneState(item))
  }
  return {
    ria: { ...cloneState(ria), tickets: hot.map(record => cloneState(record.ticket)) },
    state: { ...cloneState(state) },
    archives: [...archives.values()].sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0)),
    counts: cloneState(counts),
  }
}

/** One-way offline export/rollback helper. Live runtime never calls it. */
export function writeMirrorSnapshot({ stateDir, snapshot, storage = 'sqlite', write = writeAtomic, writeRia = false }) {
  const statePayload = { ...snapshot.state }
  delete statePayload.tickets
  delete statePayload.ticketMirror
  const stateText = JSON.stringify(statePayload, null, 2) + '\n'
  if (!stateText.trim()) throw new Error('state.json serialization produced empty output')
  write(join(stateDir, 'state.json'), stateText)
  if (writeRia) write(join(stateDir, 'ria.json'), JSON.stringify({ ...snapshot.ria, storage }, null, 2) + '\n')
  return true
}
