// Reserved WeChat image support.
//
// Both directions are intentionally not implemented yet. The switches default
// to false, and the text path never touches these helpers. When the feature is
// implemented, only this module plus the two reserved call sites should need to
// change.

export const DEFAULT_WECHAT_IMAGE_OPTIONS = Object.freeze({
  inbound: false,
  outbound: false,
})

/** Read the two image switches from plugin config; anything else stays off. */
export function normalizeWechatImageOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    inbound: source.inbound === true,
    outbound: source.outbound === true,
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
