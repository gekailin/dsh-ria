// Shared inbound-image batching for phone channels. The first image fixes the
// deadline; later images never postpone it. Every fallback is one prompt batch.
import { readFileSync } from 'node:fs'
import { readJson, writeAtomic } from './common.mjs'

export const DEFAULT_IMAGE_BUFFER_OPTIONS = Object.freeze({ timeoutMs: 120_000, maxImages: 10 })
const RETRY_MS = 1000
const SEEN_LIMIT = 500

export function normalizeImageBufferOptions(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const positive = (input, fallback, max) => {
    const number = Number(input)
    return Number.isFinite(number) && number >= 1 ? Math.min(max, Math.floor(number)) : fallback
  }
  return {
    timeoutMs: positive(raw.timeoutMs, DEFAULT_IMAGE_BUFFER_OPTIONS.timeoutMs, 2 ** 31 - 1),
    maxImages: positive(raw.maxImages, DEFAULT_IMAGE_BUFFER_OPTIONS.maxImages, Number.MAX_SAFE_INTEGER),
  }
}

const messageOf = error => String(error?.message || error)
const clone = value => JSON.parse(JSON.stringify(value))

/**
 * One service instance per channel. Buffers are keyed by (sessionId, peerId),
 * while a peer's preparation, text delivery and timer callbacks share one lock.
 * Optional persistence stores saved paths/metadata, not a second copy of bytes.
 */
export class InboundImageBuffer {
  constructor({ channel, deliver, requestId, options, file, event = () => {}, log = () => {}, onDelivered = () => {}, clock = {} }) {
    this.channel = channel
    this.deliver = deliver
    this.requestId = requestId
    this.options = typeof options === 'function' ? options : () => options
    this.file = file
    this.event = event
    this.log = log
    this.onDelivered = onDelivered
    this.now = clock.now || Date.now
    this.setTimer = clock.setTimeout || setTimeout
    this.clearTimer = clock.clearTimeout || clearTimeout
    this.states = new Map()
    this.locks = new Map()
    this.active = true
    const saved = file ? readJson(file) : null
    for (const item of saved?.buffers || []) {
      const state = { ...item, seen: new Set(item.seen || []), timer: null }
      this.states.set(this.key(state.sessionId, state.peerId), state)
    }
  }

  key(sessionId, peerId) { return JSON.stringify([this.channel, sessionId, peerId]) }

  serialize(peerId, operation) {
    const previous = this.locks.get(peerId) || Promise.resolve()
    const running = previous.catch(() => {}).then(operation)
    const settled = running.catch(() => {})
    this.locks.set(peerId, settled)
    void settled.then(() => { if (this.locks.get(peerId) === settled) this.locks.delete(peerId) })
    return running
  }

  stateFor(sessionId, peerId) {
    const key = this.key(sessionId, peerId)
    let state = this.states.get(key)
    if (!state) {
      state = { sessionId, peerId, images: [], batches: [], firstAt: null, timeoutMs: null, seen: new Set(), timer: null }
      this.states.set(key, state)
    }
    return state
  }

  metadata(images) {
    return images.map(({ fileName, size, mime, timestamp, receivedAt, sourceMessageId, path }) =>
      ({ fileName, size, mime, timestamp, receivedAt, sourceMessageId, path }))
  }

  emit(name, state, reason, count, extra = {}) {
    const payload = { channel: this.channel, peerId: state.peerId, sessionId: state.sessionId, count, reason, ...extra }
    try { this.event({ event: name, actor: 'channel:' + this.channel, sessionId: state.sessionId, reason, payload }) }
    catch (error) { this.log('warn', '[image buffer] event failed: ' + messageOf(error)) }
  }

  persist() {
    if (!this.file || !this.states.size) return
    const buffers = [...this.states.values()].map(({ timer, seen, ...state }) => ({
      ...state,
      seen: [...seen],
      images: state.images.map(image => {
        const saved = { ...image, part: image.part ? { ...image.part } : null }
        if (saved.path && saved.part) delete saved.part.data
        return saved
      }),
    }))
    writeAtomic(this.file, JSON.stringify({ version: 1, buffers }) + '\n')
  }

  remember(state, messageId) {
    if (!messageId) return
    state.seen.add(messageId)
    const pendingIds = new Set(state.images.map(image => image.sourceMessageId))
    for (const batch of state.batches) for (const id of batch.messageIds) pendingIds.add(id)
    for (const id of state.seen) {
      if (state.seen.size <= SEEN_LIMIT) break
      if (!pendingIds.has(id)) state.seen.delete(id)
    }
  }

  cancel(state) {
    if (state.timer !== null) this.clearTimer(state.timer)
    state.timer = null
  }

  schedule(state) {
    if (!this.active || state.timer !== null || (!state.images.length && !state.batches.length)) return
    const delay = state.batches.length ? RETRY_MS : Math.max(1, state.firstAt + state.timeoutMs - this.now())
    const timer = this.setTimer(() => this.serialize(state.peerId, async () => {
      if (!this.active || state.timer !== timer) return
      state.timer = null
      try {
        await this.drain(state)
        if (state.images.length && this.now() >= state.firstAt + state.timeoutMs) await this.flush(state, 'timeout')
      } catch (error) {
        this.log('warn', '[image buffer] retry pending: ' + messageOf(error))
      } finally { this.schedule(state) }
    }), delay)
    state.timer = timer
    timer?.unref?.()
  }

  imageContent(images) {
    const notes = []
    const parts = []
    for (const image of images) {
      if (image.path) notes.push('（图片已保存：' + image.path + '）')
      if (image.failure) notes.push('[图片接收失败：' + image.failure + ']')
      if (!image.part) continue
      try {
        const part = { ...image.part }
        if (!part.data) part.data = readFileSync(image.path).toString('base64')
        parts.push(part)
      } catch (error) {
        notes.push('[图片接收失败：已保存的图片不可读：' + messageOf(error) + ']')
      }
    }
    return { notes, parts }
  }

  async drain(state) {
    while (state.batches.length) {
      const batch = state.batches[0]
      try {
        this.persist()
        await this.deliver(state.sessionId, batch.content, batch.requestId)
      }
      catch (error) {
        this.emit('channel.image_flush_failed', state, batch.reason, batch.count, { requestId: batch.requestId, error: messageOf(error) })
        throw error
      }
      state.batches.shift()
      // A crash after prompt acceptance may replay the same id, never a new id.
      this.persist()
      if (batch.count) this.emit('channel.image_flushed', state, batch.reason, batch.count, {
        requestId: batch.requestId, images: batch.metadata,
      })
      try { this.onDelivered({ sessionId: state.sessionId, peerId: state.peerId, reason: batch.reason }) }
      catch (error) { this.log('warn', '[image buffer] delivery callback failed: ' + messageOf(error)) }
    }
  }

  async flush(state, reason, content, count = state.images.length, messageId = '') {
    if (!count && !Array.isArray(content)) return
    this.cancel(state)
    const images = state.images.splice(0, count)
    const { notes, parts } = this.imageContent(images)
    const original = Array.isArray(content) ? clone(content) : [{ type: 'text', text: images.length === 1 ? '（用户发来一张图片）' : '（用户发来 ' + images.length + ' 张图片）' }]
    const textParts = original.filter(part => part.type === 'text')
    if (notes.length) {
      if (textParts.length) textParts[0].text += '\n' + notes.join('\n')
      else textParts.push({ type: 'text', text: notes.join('\n') })
    }
    const batch = {
      requestId: this.requestId(), reason, count: images.length,
      content: [...textParts, ...parts, ...original.filter(part => part.type !== 'text')],
      messageIds: [...new Set([...images.map(image => image.sourceMessageId), messageId].filter(Boolean))],
      metadata: this.metadata(images),
    }
    state.batches.push(batch)
    this.remember(state, messageId)
    state.firstAt = state.images.length ? state.images[0].receivedAt : null
    if (!state.images.length) state.timeoutMs = null
    try {
      this.persist()
      await this.drain(state)
    } finally { this.schedule(state) }
  }

  /** prepare() runs inside the peer lock, so a slow download cannot reorder text. */
  submit({ sessionId, peerId = '', messageId = '', receivedAt = this.now(), prepare }) {
    peerId = String(peerId)
    messageId = messageId === undefined || messageId === null ? '' : String(messageId)
    return this.serialize(peerId, async () => {
      const target = typeof sessionId === 'function' ? await sessionId() : sessionId
      if (!target) throw new Error('image buffer requires a sessionId')
      let state = this.states.get(this.key(target, peerId))
      if (messageId && state?.seen.has(messageId)) return { duplicate: true, buffered: false, delivered: false }
      const input = await prepare()
      if (!input) return { buffered: false, delivered: false }
      // Already attempted batches retain their content/id. New input is stored
      // behind them rather than being lost when an earlier delivery is offline.
      if (input.imageOnly) {
        state ||= this.stateFor(target, peerId)
        const images = input.images.map(image => ({ ...image,
          sourceMessageId: messageId, receivedAt,
          timestamp: image.timestamp ?? receivedAt,
        }))
        if (!images.length) throw new Error('pure image message has no buffered entries')
        if (!state.images.length) {
          state.firstAt = receivedAt
          state.timeoutMs = normalizeImageBufferOptions(this.options()).timeoutMs
        }
        state.images.push(...images)
        this.remember(state, messageId)
        try {
          this.persist()
          this.emit('channel.image_buffered', state, 'awaiting-text', state.images.length, { images: this.metadata(images) })
          const limit = normalizeImageBufferOptions(this.options()).maxImages
          let delivered = false
          if (state.images.length >= limit) {
            // One multi-image message can overshoot the soft limit: flush all.
            await this.flush(state, 'limit')
            delivered = true
          }
          return { buffered: state.images.length > 0, delivered, flushed: delivered }
        } finally { this.schedule(state) }
      }
      if (input.hasText && state?.images.length) {
        // Preserve the text's exact existing body and append older image parts
        // before any images that arrived together with this text.
        await this.flush(state, 'text-arrived', input.content, state.images.length, messageId)
        return { buffered: false, delivered: true, flushed: true }
      }
      if (state?.batches.length) {
        await this.flush(state, 'text-arrived', input.content, 0, messageId)
        return { buffered: false, delivered: true, flushed: true }
      }
      await this.deliver(target, input.content)
      // Keep processed image ids too; plain text creates no buffer/timer/events.
      if (input.images?.length) {
        state ||= this.stateFor(target, peerId)
        this.remember(state, messageId)
        this.persist()
      }
      return { buffered: false, delivered: true }
    })
  }

  pending(sessionId, peerId = '') {
    const state = this.states.get(this.key(sessionId, String(peerId)))
    return state ? this.metadata(state.images) : []
  }

  resume() {
    this.active = true
    for (const state of this.states.values()) this.schedule(state)
  }

  /** Stop timers but retain durable, ordered data for reconnect/startup. */
  suspend() {
    this.active = false
    for (const state of this.states.values()) this.cancel(state)
    this.persist()
  }

  async shutdown() {
    this.suspend()
    await Promise.all([...this.locks.values()])
    this.suspend()
  }
}
