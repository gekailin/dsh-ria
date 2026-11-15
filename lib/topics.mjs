// Topic grouping for Ria's board.
//
// A topic is the durable theme a set of tickets belongs to. The board is a
// projection: projects come from the existing workspace lanes, topics group
// linked tickets inside a project, and a ticket without a primary link falls
// into that project's synthetic unclassified bucket. Nothing in this module
// touches the disk or knows about sessions, which keeps the grouping rules
// testable in isolation.

export const TOPIC_ROLES = ['primary', 'related']
export const TOPIC_TITLE_LIMIT = 200
export const TOPIC_BRIEF_LIMIT = 2000
export const TOPIC_LEVELS = [1, 2]

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function textLimit(value, limit) {
  return [...value].slice(0, limit).join('')
}

export function newTopicId(at = Date.now()) {
  return 'topic_' + at.toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

/**
 * Stored topics are read leniently: one broken record must not make the whole
 * state file unreadable. A topic without an id or title is dropped instead of
 * being invented.
 */
export function normalizeTopic(raw, at = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const topicId = asString(raw.topicId)
  const title = textLimit(asString(raw.title), TOPIC_TITLE_LIMIT)
  if (!topicId || !title) return undefined
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : at
  const level = Number.isSafeInteger(raw.level) && TOPIC_LEVELS.includes(raw.level) ? raw.level : 1
  const topic = {
    topicId,
    title,
    level,
    parentId: asString(raw.parentId) || null,
    brief: textLimit(typeof raw.brief === 'string' ? raw.brief.trim() : '', TOPIC_BRIEF_LIMIT),
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
    archivedAt: Number.isFinite(raw.archivedAt) ? raw.archivedAt : null,
    mergedInto: asString(raw.mergedInto) || null,
  }
  return topic
}

export function normalizeTopics(raw, at = Date.now()) {
  const topics = []
  const seen = new Set()
  for (const item of Array.isArray(raw) ? raw : []) {
    const topic = normalizeTopic(item, at)
    if (!topic || seen.has(topic.topicId)) continue
    seen.add(topic.topicId)
    topics.push(topic)
  }
  return topics
}

export function normalizeLink(raw, at = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const topicId = asString(raw.topicId)
  const ticketId = asString(raw.ticketId)
  if (!topicId || !ticketId) return undefined
  return {
    topicId,
    ticketId,
    role: TOPIC_ROLES.includes(raw.role) ? raw.role : 'related',
    at: Number.isFinite(raw.at) ? raw.at : at,
  }
}

/**
 * One ticket may have at most one primary topic. Reads demote every later
 * primary to related; writes go through linkTopic below and report the demoted
 * topic so the caller can show it.
 */
export function normalizeLinks(raw, at = Date.now()) {
  const links = []
  const pairs = new Map()
  const primaryByTicket = new Set()
  for (const item of Array.isArray(raw) ? raw : []) {
    const link = normalizeLink(item, at)
    if (!link) continue
    const key = link.topicId + '\u0000' + link.ticketId
    const known = pairs.get(key)
    if (known) {
      if (link.role === 'primary' && known.role !== 'primary') {
        known.role = 'primary'
        known.at = Math.max(known.at, link.at)
      }
      continue
    }
    if (link.role === 'primary') {
      if (primaryByTicket.has(link.ticketId)) link.role = 'related'
      else primaryByTicket.add(link.ticketId)
    }
    pairs.set(key, link)
    links.push(link)
  }
  return links
}

export function linksForTopic(links, topicId) {
  return (Array.isArray(links) ? links : []).filter(link => link.topicId === topicId)
}

export function linksForTicket(links, ticketId) {
  return (Array.isArray(links) ? links : []).filter(link => link.ticketId === ticketId)
}

export function primaryTopicForTicket(links, ticketId) {
  return (Array.isArray(links) ? links : []).find(link => link.ticketId === ticketId && link.role === 'primary')
}

/**
 * Add or replace one link. A new primary demotes the ticket's old primary to
 * related (the newest decision wins), and linking a ticket to the same topic
 * again only changes its role. Returns {links, demoted}.
 */
export function linkTopic(links, topicId, ticketId, role = 'related', at = Date.now()) {
  if (!topicId || !ticketId) return { links: Array.isArray(links) ? links.slice() : [], demoted: null }
  const wanted = TOPIC_ROLES.includes(role) ? role : 'related'
  const next = (Array.isArray(links) ? links : []).map(link => ({ ...link }))
  let demoted = null
  const existing = next.find(link => link.topicId === topicId && link.ticketId === ticketId)
  if (wanted === 'primary') {
    for (const link of next) {
      if (link.ticketId === ticketId && link.role === 'primary' && link.topicId !== topicId) {
        link.role = 'related'
        demoted = link.topicId
      }
    }
  }
  if (existing) {
    existing.role = wanted
    existing.at = at
  } else {
    next.push({ topicId, ticketId, role: wanted, at })
  }
  return { links: normalizeLinks(next, at), demoted }
}

export function unlinkTopic(links, topicId, ticketId) {
  return (Array.isArray(links) ? links : []).filter(link => !(link.topicId === topicId && link.ticketId === ticketId))
}

/**
 * Move every link from source to target. When both topics already link the
 * same ticket, the moved primary stays primary and the target's old primary is
 * demoted, matching the one-primary rule.
 */
export function mergeTopicLinks(links, sourceTopicId, targetTopicId, at = Date.now()) {
  const next = (Array.isArray(links) ? links : []).map(link => ({ ...link }))
  const byPair = new Map()
  next.forEach((link, index) => byPair.set(link.topicId + '\u0000' + link.ticketId, index))
  let moved = 0
  for (let index = 0; index < next.length; index += 1) {
    const link = next[index]
    if (!link || link.topicId !== sourceTopicId) continue
    const key = targetTopicId + '\u0000' + link.ticketId
    const existingIndex = byPair.get(key)
    if (existingIndex !== undefined && existingIndex !== index) {
      const existing = next[existingIndex]
      if (link.role === 'primary' && existing.role !== 'primary') {
        existing.role = 'primary'
        existing.at = at
      }
      link.topicId = null
      moved += 1
      continue
    }
    link.topicId = targetTopicId
    link.at = at
    byPair.set(key, index)
    moved += 1
  }
  const kept = next.filter(link => link.topicId)
  // A ticket can carry several primaries after the move only when both topics
  // linked it before; the link with the newest decision wins.
  const primaryByTicket = new Map()
  for (const link of kept) {
    if (link.role !== 'primary') continue
    const current = primaryByTicket.get(link.ticketId)
    if (!current || (link.at || 0) > (current.at || 0)) {
      if (current) current.role = 'related'
      primaryByTicket.set(link.ticketId, link)
    } else {
      link.role = 'related'
    }
  }
  return { links: normalizeLinks(kept, at), moved }
}

export function topicTicketIds(links, topicId) {
  return [...new Set(linksForTopic(links, topicId).map(link => link.ticketId))]
}
