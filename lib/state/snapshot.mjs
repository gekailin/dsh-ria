/** Private transaction drafts preserve undefined fields and object identity.
 * Publishing reconciles into existing objects only after COMMIT; callers that
 * held a live ticket/history reference never observe a failed draft.
 */
export const cloneState = value => structuredClone(value)

export function publishState(target, source, mapped = new WeakMap()) {
  if (!source || typeof source !== 'object') return source
  if (!target || typeof target !== 'object' || Array.isArray(target) !== Array.isArray(source)) {
    target = Array.isArray(source) ? [] : {}
  }
  mapped.set(source, target)
  if (Array.isArray(source)) {
    const previous = target.slice()
    // A topic link is identified by its (topicId, ticketId) pair. Using bare
    // topicId here collapsed every link of one topic onto the first/last old
    // link object during publish, duplicating one ticket N times.
    const identity = value => {
      if (!value || typeof value !== 'object') return null
      if (value.linkId) return value.linkId
      if (value.topicId && value.ticketId) return 'link:' + value.topicId + '\u0000' + value.ticketId
      return value.reportId || value.requestId || value.topicId || value.feedbackId
        || value.deliveryId || value.grantId || value.noteId || value.id
        || (value.status && value.goal !== undefined ? value.ticketId : null)
    }
    const byId = new Map(previous.filter(identity).map(item => [identity(item), item]))
    const next = source.map((item, index) => publishState(identity(item) ? byId.get(identity(item)) : previous[index], item, mapped))
    target.splice(0, target.length, ...next)
    return target
  }
  for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key]
  for (const [key, value] of Object.entries(source)) target[key] = publishState(target[key], value, mapped)
  return target
}

export function mapPublishedResult(value, mapped, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value
  if (mapped.has(value)) return mapped.get(value)
  if (seen.has(value)) return seen.get(value)
  // Return wrappers may contain both a ticket and plain metadata. Only remap
  // the private objects that were published, without cloning Error/Date values.
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return value
  const result = Array.isArray(value) ? [] : {}
  seen.set(value, result)
  for (const [key, item] of Object.entries(value)) result[key] = mapPublishedResult(item, mapped, seen)
  return result
}
