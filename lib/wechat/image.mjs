// WeChat image support (outbound + inbound).
//
// Outbound lives in wxweb.mjs (uploadMedia/sendImage). Inbound lives here plus
// WebWxClient.downloadImage: parse the <img> metadata from the sync message,
// fetch the original bytes with the authenticated web protocol, validate the
// magic bytes and size, save a copy under <stateDir>/wechat-inbound, and hand
// the host a normal { type: 'image', mediaType, data, name } content part.
//
// A failed download never drops the user's message: the service keeps the
// caption (or a placeholder) and appends a visible failure line.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export const DEFAULT_WECHAT_IMAGE_OPTIONS = Object.freeze({
  inbound: true,
  outbound: true,
})

export const DEFAULT_INBOUND_IMAGE_MAX_BYTES = 20 * 1024 * 1024
export const DEFAULT_INBOUND_IMAGE_RETENTION_DAYS = 30
export const DEFAULT_INBOUND_IMAGE_MAX_FILES = 500
export const INBOUND_IMAGE_DIR = 'wechat-inbound'
export const IMAGE_PLACEHOLDER = '（用户发来一张图片）'

export class InboundImageError extends Error {
  constructor(message, code, reason) {
    super(message)
    this.name = 'InboundImageError'
    this.code = code
    this.reason = reason || message
  }
}

/** Read the two image switches from plugin config; only an explicit true/false changes a default. */
export function normalizeWechatImageOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    inbound: typeof source.inbound === 'boolean' ? source.inbound : DEFAULT_WECHAT_IMAGE_OPTIONS.inbound,
    outbound: typeof source.outbound === 'boolean' ? source.outbound : DEFAULT_WECHAT_IMAGE_OPTIONS.outbound,
  }
}

/** WeChat MsgType 3 is an image. The text path handles only MsgType 1. */
export function isImageMessage(message) {
  return Boolean(message) && Number(message.type) === 3
}

function decodeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Parse the attributes of the <img> tag in an inbound image Content field. */
export function parseImageContent(content) {
  const attrs = {}
  const text = String(content == null ? '' : content)
  const tag = /<img\b([^>]*)>/i.exec(text)
  if (tag) {
    const re = /([A-Za-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g
    let m
    while ((m = re.exec(tag[1]))) {
      attrs[m[1].toLowerCase()] = decodeXml(m[2] ?? m[3] ?? m[4] ?? '')
    }
  }
  const caption = decodeXml(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
  return { attrs, caption }
}

/** The original caption, or a readable placeholder when WeChat sent a bare image. */
export function imageCaption(message) {
  const { attrs, caption } = parseImageContent(message && ((message.raw && message.raw.Content) || message.text))
  void attrs
  return caption || IMAGE_PLACEHOLDER
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value)
  }
  return ''
}

function imageMeta(message) {
  const raw = (message && message.raw) || {}
  const { attrs, caption } = parseImageContent(raw.Content || (message && message.text))
  const msgId = firstValue(raw.MsgId, attrs.msgid, message && message.id)
  return {
    msgId,
    mediaId: firstValue(attrs.mediaid, attrs.attachid),
    sender: firstValue(message && message.from, raw.FromUserName),
    encryFilename: firstValue(attrs.encryfilename, attrs.filename),
    filename: firstValue(attrs.filename, raw.FileName),
    caption,
  }
}

function safeSegment(value, fallback) {
  const text = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
  return text || fallback
}

function timestamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) +
    '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds())
}

function extensionFor(mediaType) {
  if (mediaType === 'image/png') return 'png'
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/gif') return 'gif'
  if (mediaType === 'image/webp') return 'webp'
  return 'bin'
}

function saveBytes(dir, msgId, bytes, mediaType) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const base = timestamp() + '-' + safeSegment(msgId, 'image')
  const ext = extensionFor(mediaType)
  for (let n = 0; n < 1000; n += 1) {
    const file = join(dir, base + (n ? '-' + (n + 1) : '') + '.' + ext)
    let fd
    try {
      fd = openSync(file, 'wx', 0o600)
      try {
        writeSync(fd, bytes)
      } finally {
        closeSync(fd)
      }
      return file
    } catch (error) {
      try { if (fd !== undefined) closeSync(fd) } catch { /* already closed */ }
      if (error && error.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('could not allocate a unique inbound image filename')
}

/**
 * Remove old inbound images. Keeps at most maxFiles and drops files older than
 * retentionDays. Pruning is best-effort: one unreadable file never blocks the
 * delivery that triggered it.
 */
export function pruneInboundImages(dir, {
  retentionDays = DEFAULT_INBOUND_IMAGE_RETENTION_DAYS,
  maxFiles = DEFAULT_INBOUND_IMAGE_MAX_FILES,
  now = Date.now(),
  log = () => {},
} = {}) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { removed: 0, kept: 0 }
  }
  const files = []
  let removed = 0
  const maxAge = Math.max(0, Number(retentionDays) || 0) * 24 * 60 * 60 * 1000
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue
    const file = join(dir, entry.name)
    try {
      const info = statSync(file)
      if (maxAge > 0 && now - info.mtimeMs > maxAge) {
        unlinkSync(file)
        removed += 1
        continue
      }
      files.push({ file, mtimeMs: info.mtimeMs })
    } catch (error) {
      log('warn', 'could not inspect inbound image ' + file + ': ' + String(error && error.message ? error.message : error))
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const keep = Math.max(1, Number(maxFiles) || DEFAULT_INBOUND_IMAGE_MAX_FILES)
  for (const item of files.slice(keep)) {
    try {
      unlinkSync(item.file)
      removed += 1
    } catch (error) {
      log('warn', 'could not prune inbound image ' + item.file + ': ' + String(error && error.message ? error.message : error))
    }
  }
  return { removed, kept: Math.min(files.length, keep) }
}

/**
 * Download, validate and persist one inbound WeChat image.
 *
 * @param {{ id?: string|number, type?: number|string, raw?: object, from?: string }} message
 * @param {{ client?: object, signal?: AbortSignal, stateDir: string, maxBytes?: number, retentionDays?: number, maxFiles?: number, log?: Function }} options
 * @returns {Promise<{ part: {type:'image',mediaType:string,data:string,name:string}, path: string, mediaType: string, name: string, text: string, msgId: string, bytes: number }>}
 */
export async function receiveInboundImage(message, {
  client,
  signal,
  stateDir,
  maxBytes = DEFAULT_INBOUND_IMAGE_MAX_BYTES,
  retentionDays = DEFAULT_INBOUND_IMAGE_RETENTION_DAYS,
  maxFiles = DEFAULT_INBOUND_IMAGE_MAX_FILES,
  log = () => {},
} = {}) {
  if (!isImageMessage(message)) {
    throw new InboundImageError('not a WeChat image message', 'image_invalid', '不是微信图片消息')
  }
  const meta = imageMeta(message)
  const label = meta.msgId || '(no MsgID)'
  if (!stateDir) throw new InboundImageError('stateDir is required', 'image_no_state', '缺少图片保存目录')
  if (!client || typeof client.downloadImage !== 'function') {
    throw new InboundImageError('WeChat image downloader is unavailable', 'image_no_client', '微信连接不可用，无法下载图片')
  }
  if (!meta.msgId && !meta.mediaId) {
    throw new InboundImageError('WeChat image message has no MsgID or MediaId', 'image_invalid', '图片消息缺少 MsgID')
  }
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_INBOUND_IMAGE_MAX_BYTES
  let bytes
  try {
    bytes = await client.downloadImage({
      msgId: meta.msgId,
      mediaId: meta.mediaId,
      sender: meta.sender,
      encryFilename: meta.encryFilename,
      filename: meta.filename,
      signal,
      maxBytes: limit,
    })
  } catch (error) {
    const reason = String(error && error.message ? error.message : error)
    throw new InboundImageError('WeChat image download failed: ' + reason, 'image_download_failed', '下载失败：' + reason)
  }
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new InboundImageError('WeChat image download returned no bytes', 'image_download_failed', '下载失败：没有返回图片数据')
  }
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (!data.length) {
    throw new InboundImageError('WeChat inbound image is empty', 'image_empty', '图片为空')
  }
  if (data.length > limit) {
    throw new InboundImageError('WeChat inbound image is too large: ' + data.length + ' > ' + limit, 'image_too_large', '图片超过 ' + Math.floor(limit / (1024 * 1024)) + ' MB 限制')
  }
  const mediaType = imageMediaType(data)
  if (!mediaType) {
    throw new InboundImageError('unsupported WeChat image type (png/jpeg/gif/webp only)', 'image_unsupported', '图片格式不支持（只接受 png/jpeg/gif/webp）')
  }
  const imageDir = resolve(stateDir, INBOUND_IMAGE_DIR)
  let path
  try {
    path = saveBytes(imageDir, meta.msgId, data, mediaType)
  } catch (error) {
    const reason = String(error && error.message ? error.message : error)
    throw new InboundImageError('could not save WeChat image: ' + reason, 'image_save_failed', '保存图片失败：' + reason)
  }
  try {
    pruneInboundImages(imageDir, { retentionDays, maxFiles, log })
  } catch (error) {
    log('warn', 'could not prune inbound images: ' + String(error && error.message ? error.message : error))
  }
  const name = basename(path)
  const caption = meta.caption
  const text = caption
    ? caption + '\n\n（图片已保存：' + path + '）'
    : IMAGE_PLACEHOLDER + '\n（图片已保存：' + path + '）'
  log('info', 'received WeChat image ' + label + ' -> ' + path + ' (' + data.length + ' bytes, ' + mediaType + ')')
  return {
    part: { type: 'image', mediaType, data: data.toString('base64'), name },
    path,
    mediaType,
    name,
    text,
    msgId: meta.msgId,
    bytes: data.length,
  }
}

/**
 * Convert one inbound WeChat image message into a DSH image content part.
 * Kept as a small wrapper for callers that only need the part; the service
 * uses receiveInboundImage so it can also deliver the saved path as text.
 */
export async function imagePartFromMessage(message, options = {}) {
  if (!isImageMessage(message)) throw new Error('not a WeChat image message')
  const received = await receiveInboundImage(message, options)
  return received.part
}

/** Text that must still be delivered when the image path fails. */
export function imageFailureText(message, reason) {
  const detail = String(reason == null ? '' : reason).replace(/\s+/g, ' ').trim().slice(0, 300) || '未知错误'
  const caption = imageCaption(message)
  return caption + '\n[图片接收失败：' + detail + ']'
}

/** Detect the four image types WeChat can send from their magic bytes. */
export function imageMediaType(bytes) {
  if (!bytes || bytes.length < 12) return undefined
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.slice(0, 6).toString('latin1') === 'GIF87a' || bytes.slice(0, 6).toString('latin1') === 'GIF89a') return 'image/gif'
  if (bytes.slice(0, 4).toString('latin1') === 'RIFF' && bytes.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return undefined
}
