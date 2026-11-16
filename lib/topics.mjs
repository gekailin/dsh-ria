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
export const TOPIC_SUMMARY_GOAL_LIMIT = 60

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function textLimit(value, limit) {
  return [...value].slice(0, limit).join('')
}

const TOPIC_SUMMARY_TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled'])
const TOPIC_SUMMARY_STATUS_LABELS = {
  intake: '待分诊',
  open: '待执行',
  working: '进行中',
  blocked: '卡住',
  forked: '已分叉',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/**
 * Ticket counts for a topic card. `open` includes blocked tickets because the
 * card shows every unfinished, non-working ticket in its pending section;
 * `done` folds failed and cancelled into the terminal count.
 */
export function topicProgressCounts(views) {
  const counts = { total: 0, open: 0, working: 0, blocked: 0, done: 0 }
  for (const view of Array.isArray(views) ? views : []) {
    counts.total += 1
    if (view && view.status === 'working') counts.working += 1
    else if (view && view.status === 'blocked') {
      counts.blocked += 1
      counts.open += 1
    } else if (view && TOPIC_SUMMARY_TERMINAL_STATUSES.has(view.status)) counts.done += 1
    else counts.open += 1
  }
  return counts
}

function summaryNewest(views) {
  let newest
  let newestAt = -Infinity
  for (const view of views) {
    const at = Number(view && view.updatedAt) || 0
    if (!newest || at > newestAt) {
      newest = view
      newestAt = at
    }
  }
  return newest || {}
}

function summaryGoal(view) {
  const goal = asString(view && view.goal).replace(/\s+/g, ' ')
  const chars = [...goal]
  if (chars.length <= TOPIC_SUMMARY_GOAL_LIMIT) return goal
  return chars.slice(0, TOPIC_SUMMARY_GOAL_LIMIT).join('') + '…'
}

/**
 * The sentence shown under a topic title. A hand-written brief always wins;
 * otherwise the board derives one from the newest ticket and the card counts,
 * so a topic never goes blank just because Ria has not written a brief yet.
 * The caller receives `auto` so a client can tell the two apart.
 */
export function topicSummaryInfo(topic, views) {
  const list = Array.isArray(views) ? views : []
  const brief = asString(topic && topic.brief)
  if (brief) return { text: brief, auto: false }
  if (!list.length) return { text: '暂无工单', auto: true }
  const newest = summaryNewest(list)
  const goal = summaryGoal(newest)
  if (topic && topic.unclassified) return { text: list.length + ' 张待分类 · 最近：「' + goal + '」', auto: true }
  const counts = topicProgressCounts(list)
  const status = TOPIC_SUMMARY_STATUS_LABELS[newest.status] || String(newest.status || '')
  const parts = ['「' + goal + '」' + status]
  if (counts.open) parts.push('待执行 ' + counts.open)
  if (counts.working) parts.push('执行中 ' + counts.working)
  if (counts.done) parts.push('已完成 ' + counts.done)
  return { text: parts.join(' · '), auto: true }
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
