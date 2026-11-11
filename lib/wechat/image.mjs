// Reserved WeChat image support.
//
// Both directions are intentionally not implemented yet. The switches default
// to false, and the text path never touches these helpers. When the feature is
// implemented, only this module plus the two reserved call sites should need to
// change.

export const DEFAULT_WECHAT_IMAGE_OPTIONS = Object.freeze({
  inbound: false,
  outbound: true,
})

/** Read the two image switches from plugin config; only an explicit true/false changes a default. */
export function normalizeWechatImageOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    inbound: source.inbound === true,
    outbound: typeof source.outbound === 'boolean' ? source.outbound : DEFAULT_WECHAT_IMAGE_OPTIONS.outbound,
  }
}

/** WeChat MsgType 3 is an image. The text path handles only MsgType 1. */
export function isImageMessage(message) {
  return Boolean(message) && Number(message.type) === 3
}

/**
 * Convert one inbound WeChat image message into a DSH image content part.
 *
 * Reserved signature. A full implementation must:
 *   1. parse the <img> metadata out of message.raw.Content (msgid, length,
 *      cdnthumburl/cdnmidimgurl, and any encryption fields);
 *   2. download the bytes with the authenticated WebWxClient (for the File
 *      Transfer Helper, start with /cgi-bin/mmwebwx-bin/webwxgetmsgimg and
 *      fall back to webwxgetmedia if the CDN URL requires it);
 *   3. detect the media type, base64-encode the bytes, and return
 *      { type: 'image', mediaType, data, name? } for sessionController.prompt.
 *
 * TODO(inbound image): implement the three steps above. Until then this throws
 * a clear error, so enabling the reserved switch cannot silently deliver a
 * broken message.
 *
 * @param {{ id?: string|number, type?: number|string, raw?: object }} message
 * @param {{ client?: object, signal?: AbortSignal }} [options]
 * @returns {Promise<{ type: 'image', mediaType: string, data: string, name?: string }>}
 */
export async function imagePartFromMessage(message, { client, signal } = {}) {
  if (!isImageMessage(message)) throw new Error('not a WeChat image message')
  void client
  void signal
  // TODO(inbound image): parse + download + convert as described above.
  throw new Error('WeChat inbound images are reserved but not implemented')
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
