// 微信「文件传输助手网页版」协议客户端（wenjian.weixin.qq.com）。
// 它在协议上和 wx.qq.com 同源同构，但独立 appid：wx_webfilehelper，
// 且不受「网页版微信」的登录限制——只做 filehelper 一个会话。
import { createHash } from 'node:crypto'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const FILEHELPER_APPID = 'wx_webfilehelper';
export const FILEHELPER_BASE = 'https://wenjian.weixin.qq.com';
export const FILEHELPER_LOGIN = 'https://login.wx.qq.com';
export const REQUEST_TIMEOUT_MS = 20_000;
export const SYNCCHECK_TIMEOUT_MS = 45_000;

export class WebWxError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WebWxError';
    this.code = code;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function newDeviceId() {
  return String(Math.random()).slice(2, 17);
}

export function syncKeyToString(syncKey) {
  if (!syncKey?.List) return '';
  return syncKey.List.map((i) => i.Key + '_' + i.Val).join('|');
}

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function fileBaseFor(base) {
  const host = new URL(base).hostname;
  if (host.includes('wx2.qq.com')) return 'https://file.wx2.qq.com';
  if (host.includes('wx8.qq.com')) return 'https://file.wx8.qq.com';
  if (host.includes('web2.wechat.com')) return 'https://file.web2.wechat.com';
  if (host.includes('wechat.com')) return 'https://file.web.wechat.com';
  return 'https://file.wx.qq.com';
}

export function normalize(raw) {
  const text = raw.MsgType === 49 ? parseAppMsgTitle(raw.Content) : raw.Content;
  return {
    id: raw.MsgId,
    from: raw.FromUserName,
    to: raw.ToUserName,
    type: raw.MsgType,
    text: text ?? '',
    ts: raw.CreateTime,
    raw,
  };
}

function parseAppMsgTitle(content) {
  const m = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(content || '');
  return m ? m[1] : '[app message]';
}

export class WebWxClient {
  constructor(creds, opts = {}) {
    const base = (creds.base || FILEHELPER_BASE).replace(/\/$/, '');
    this.creds = {
      appId: FILEHELPER_APPID,
      deviceid: newDeviceId(),
      ...creds,
      base,
    };
    this.syncBase =
      creds.syncBase ||
      (new URL(base).hostname.endsWith('qq.com') && !new URL(base).hostname.startsWith('wenjian')
        ? base.replace('://', '://webpush.')
        : base);
    this.opts = opts;
    this.log = opts.log || (() => {});
    this.syncKey = null;
    this.self = null;
    this.sentIds = new Set();
  }

  baseRequest() {
    return {
      Uin: Number(this.creds.uin),
      Sid: this.creds.sid,
      Skey: this.creds.skey,
      DeviceID: this.creds.deviceid,
    };
  }

  headers(extra = {}) {
    return {
      'User-Agent': UA,
      Referer: this.creds.base + '/',
      Cookie: this.creds.cookie || '',
      ...(this.creds.appId ? { mmweb_appid: this.creds.appId } : {}),
      ...extra,
    };
  }

  async request(path, { method = 'GET', query, body, base, raw = false, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const url = new URL(path, base || this.creds.base);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers = this.headers();
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json;charset=UTF-8';
      payload = JSON.stringify(body);
    }
    this.log(method + ' ' + url.pathname);
    const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : null;
    const reqSignal = signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : (signal || timeoutSignal);
    const res = await fetch(url, { method, headers, body: payload, ...(reqSignal ? { signal: reqSignal } : {}) });
    const text = await res.text();
    if (!res.ok) throw new WebWxError('HTTP ' + res.status + ' ' + url.pathname, res.status);
    if (raw) return text;
    try {
      return JSON.parse(text);
    } catch {
      throw new WebWxError('非 JSON 响应 ' + url.pathname + ': ' + text.slice(0, 120));
    }
  }

  /** Fetch raw bytes (images) instead of parsing JSON/text. */
  async requestBuffer(path, { query, base, signal, timeoutMs = REQUEST_TIMEOUT_MS * 3, maxBytes = 20 * 1024 * 1024 } = {}) {
    const url = new URL(path, base || this.creds.base);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    this.log('GET ' + url.pathname);
    const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : null;
    const reqSignal = signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : (signal || timeoutSignal);
    const res = await fetch(url, { headers: this.headers(), ...(reqSignal ? { signal: reqSignal } : {}) });
    if (!res.ok) {
      try { await res.body?.cancel?.() } catch { /* best effort */ }
      throw new WebWxError('HTTP ' + res.status + ' ' + url.pathname, res.status);
    }
    const type = String(res.headers.get('content-type') || '');
    if (type.includes('application/json') || type.startsWith('text/')) {
      const body = await res.text();
      throw new WebWxError('非图片响应 ' + url.pathname + ': ' + body.slice(0, 120), 'bad_image_response');
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      try { await res.body?.cancel?.() } catch { /* best effort */ }
      throw new WebWxError('图片超过大小上限（' + maxBytes + ' 字节）', 'image_too_large');
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > maxBytes) throw new WebWxError('图片超过大小上限（' + maxBytes + ' 字节）', 'image_too_large');
      return data;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          await reader.cancel();
          throw new WebWxError('图片超过大小上限（' + maxBytes + ' 字节）', 'image_too_large');
        }
        chunks.push(chunk);
      }
    } finally {
      try { reader.releaseLock() } catch { /* already released */ }
    }
    return Buffer.concat(chunks, total);
  }

  async init() {
    const r = await this.request('/cgi-bin/mmwebwx-bin/webwxinit', {
      method: 'POST',
      query: { r: ~Date.now(), lang: 'zh_CN', pass_ticket: this.creds.passTicket },
      body: { BaseRequest: this.baseRequest() },
    });
    if (r?.BaseResponse?.Ret !== 0) {
      throw new WebWxError('webwxinit 失败 Ret=' + r?.BaseResponse?.Ret, r?.BaseResponse?.Ret);
    }
    this.syncKey = r.SyncKey;
    this.self = r.User;
    if (r.SKey) this.creds.skey = r.SKey;
    this.log('登录身份: ' + this.self.NickName + ' (' + this.self.UserName + ')');
    return r;
  }

  // 文件传输助手网页版不需要 statusnotify；普通网页版微信才需要。
  async statusNotify() {
    if (this.creds.appId === FILEHELPER_APPID) return null;
    if (!this.self) throw new WebWxError('先 init()');
    return this.request('/cgi-bin/mmwebwx-bin/webwxstatusnotify', {
      method: 'POST',
      query: { pass_ticket: this.creds.passTicket },
      body: {
        BaseRequest: this.baseRequest(),
        Code: 3,
        FromUserName: this.self.UserName,
        ToUserName: this.self.UserName,
        ClientMsgId: Date.now(),
      },
    });
  }

  async syncCheck({ signal } = {}) {
    const text = await this.request('/cgi-bin/mmwebwx-bin/synccheck', {
      base: this.syncBase,
      raw: true,
      signal,
      timeoutMs: SYNCCHECK_TIMEOUT_MS,
      query: {
        r: Date.now(),
        skey: this.creds.skey,
        sid: this.creds.sid,
        uin: this.creds.uin,
        deviceid: this.creds.deviceid,
        synckey: syncKeyToString(this.syncKey),
        mmweb_appid: this.creds.appId,
      },
    });
    const m = /retcode\s*:\s*"(\d+)"\s*,\s*selector\s*:\s*"(\d+)"/.exec(text);
    if (!m) throw new WebWxError('synccheck 响应异常: ' + text.slice(0, 120));
    return { retcode: m[1], selector: m[2] };
  }

  async sync({ signal } = {}) {
    const r = await this.request('/cgi-bin/mmwebwx-bin/webwxsync', {
      method: 'POST',
      signal,
      query: {
        sid: this.creds.sid,
        skey: this.creds.skey,
        pass_ticket: this.creds.passTicket,
      },
      body: {
        BaseRequest: this.baseRequest(),
        SyncKey: this.syncKey,
        rr: ~Date.now(),
      },
    });
    if (r?.BaseResponse?.Ret !== 0) {
      throw new WebWxError('webwxsync 失败 Ret=' + r?.BaseResponse?.Ret, r?.BaseResponse?.Ret);
    }
    if (r.SyncKey) this.syncKey = r.SyncKey;
    return r.AddMsgList || [];
  }

  async sendText(to, content) {
    if (!this.self) throw new WebWxError('先 init()');
    const clientMsgId = String(Date.now()) + String(Math.floor(Math.random() * 1e4)).padStart(4, '0');
    const body = {
      BaseRequest: this.baseRequest(),
      Msg: {
        Type: 1,
        Content: content,
        FromUserName: this.self.UserName,
        ToUserName: to,
        LocalID: clientMsgId,
        ClientMsgId: clientMsgId,
      },
    };
    if (this.creds.appId === FILEHELPER_APPID) body.Scene = 0;
    const r = await this.request('/cgi-bin/mmwebwx-bin/webwxsendmsg', {
      method: 'POST',
      query: { lang: 'zh_CN', pass_ticket: this.creds.passTicket },
      body,
    });
    if (r?.BaseResponse?.Ret !== 0) {
      throw new WebWxError('webwxsendmsg 失败 Ret=' + r?.BaseResponse?.Ret, r?.BaseResponse?.Ret);
    }
    // 文件传输助手是「和自己对话」：回复同样 to=filehelper、from=自己，
    // 必须靠 MsgID 把自己刚发的这条从同步流里排掉。
    this.sentIds.add(String(r.MsgID));
    if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value);
    return r.MsgID;
  }

  /**
   * Upload one small media object (file or image) to file.wx.qq.com.
   * Mirrors the web client's WebUploader request: one chunk, one multipart POST.
   */
  async uploadMedia(to, { name, buffer, mime, formMediaType, uploadMediaType, signal } = {}) {
    if (!this.self) throw new WebWxError('先 init()');
    if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
      throw new WebWxError('uploadMedia 需要 Buffer');
    }
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const fileName = String(name || 'file').replace(/[\\/:*?"<>|\r\n]/g, '_');
    const md5 = createHash('md5').update(bytes).digest('hex');
    const clientMediaId = String(Date.now());
    const uploadRequest = {
      BaseRequest: this.baseRequest(),
      ClientMediaId: clientMediaId,
      TotalLen: bytes.length,
      StartPos: 0,
      DataLen: bytes.length,
      MediaType: uploadMediaType,
      FromUserName: this.self.UserName,
      ToUserName: to,
      FileMd5: md5,
      UploadType: 2,
    };
    const form = new FormData();
    form.append('id', 'WU_FILE_0');
    form.append('name', fileName);
    form.append('type', mime);
    form.append('lastModifiedDate', new Date().toUTCString());
    form.append('size', String(bytes.length));
    form.append('chunks', '1');
    form.append('chunk', '0');
    form.append('mediatype', formMediaType);
    form.append('webwx_data_ticket', cookieValue(this.creds.cookie, 'webwx_data_ticket'));
    form.append('pass_ticket', safeDecode(this.creds.passTicket));
    form.append('uploadmediarequest', JSON.stringify(uploadRequest));
    form.append('filename', new Blob([bytes], { type: mime }), fileName);

    const uploadUrl = new URL('/cgi-bin/mmwebwx-bin/webwxuploadmedia?f=json', fileBaseFor(this.creds.base));
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS * 3);
    const uploadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    this.log('POST ' + uploadUrl.pathname);
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: this.headers({ Referer: this.creds.base + '/' }),
      body: form,
      signal: uploadSignal,
    });
    const uploadText = await uploadRes.text();
    if (!uploadRes.ok) throw new WebWxError('HTTP ' + uploadRes.status + ' ' + uploadUrl.pathname, uploadRes.status);
    let upload;
    try {
      upload = JSON.parse(uploadText);
    } catch {
      throw new WebWxError('上传响应不是 JSON: ' + uploadText.slice(0, 120));
    }
    if (upload?.BaseResponse?.Ret !== 0) {
      throw new WebWxError('webwxuploadmedia 失败 Ret=' + upload?.BaseResponse?.Ret, upload?.BaseResponse?.Ret);
    }
    if (!upload.MediaId) throw new WebWxError('上传响应缺少 MediaId');
    return { upload, fileName, bytes };
  }

  /**
   * Upload one file and send it as an app message.
   */
  async sendFile(to, { name, buffer, mime = 'application/octet-stream', signal } = {}) {
    const { upload, fileName, bytes } = await this.uploadMedia(to, {
      name,
      buffer,
      mime,
      formMediaType: 'doc',
      uploadMediaType: 4,
      signal,
    });
    const mediaId = upload.MediaId;
    const dot = fileName.lastIndexOf('.');
    const fileExt = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';

    const content = '<appmsg appid="wxeb7ec651dd0aefa9" sdkver="">' +
      '<title>' + escapeXml(fileName) + '</title>' +
      '<des></des><action></action><type>6</type><content></content><url></url><lowurl></lowurl>' +
      '<appattach><totallen>' + bytes.length + '</totallen><attachid>' + escapeXml(mediaId) + '</attachid>' +
      '<fileext>' + escapeXml(fileExt) + '</fileext></appattach><extinfo></extinfo></appmsg>';
    const clientMsgId = String(Date.now()) + String(Math.floor(Math.random() * 1e4)).padStart(4, '0');
    const msg = {
      Type: 6,
      Content: content,
      FromUserName: this.self.UserName,
      ToUserName: to,
      LocalID: clientMsgId,
      ClientMsgId: clientMsgId,
    };
    if (upload.Signature) msg.Signature = upload.Signature;
    const body = { BaseRequest: this.baseRequest(), Msg: msg };
    if (this.creds.appId === FILEHELPER_APPID) body.Scene = 0;
    const r = await this.request('/cgi-bin/mmwebwx-bin/webwxsendappmsg', {
      method: 'POST',
      query: { fun: 'async', f: 'json' },
      body,
      signal,
    });
    if (r?.BaseResponse?.Ret !== 0) {
      throw new WebWxError('webwxsendappmsg 失败 Ret=' + r?.BaseResponse?.Ret, r?.BaseResponse?.Ret);
    }
    if (r.MsgID) {
      this.sentIds.add(String(r.MsgID));
      if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value);
    }
    return r.MsgID;
  }

  /**
   * Upload one image (mediatype=pic) and send it as MsgType 3 via
   * webwxsendmsgimg. The web client sends the uploaded MediaId and lets the
   * server attach the CDN URLs; no appmsg wrapper is involved.
   */
  async sendImage(to, { name, buffer, mime = 'image/png', signal } = {}) {
    if (!this.self) throw new WebWxError('先 init()');
    if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
      throw new WebWxError('sendImage 需要 Buffer');
    }
    const { upload } = await this.uploadMedia(to, {
      name,
      buffer,
      mime,
      formMediaType: 'pic',
      uploadMediaType: 3,
      signal,
    });
    const clientMsgId = String(Date.now()) + String(Math.floor(Math.random() * 1e4)).padStart(4, '0');
    const body = {
      BaseRequest: this.baseRequest(),
      Msg: {
        Type: 3,
        MediaId: upload.MediaId,
        Content: '',
        FromUserName: this.self.UserName,
        ToUserName: to,
        LocalID: clientMsgId,
        ClientMsgId: clientMsgId,
      },
    };
    if (this.creds.appId === FILEHELPER_APPID) body.Scene = 0;
    const r = await this.request('/cgi-bin/mmwebwx-bin/webwxsendmsgimg', {
      method: 'POST',
      query: { fun: 'async', f: 'json', lang: 'zh_CN', pass_ticket: this.creds.passTicket },
      body,
      signal,
    });
    if (r?.BaseResponse?.Ret !== 0) {
      throw new WebWxError('webwxsendmsgimg 失败 Ret=' + r?.BaseResponse?.Ret, r?.BaseResponse?.Ret);
    }
    if (r.MsgID) {
      this.sentIds.add(String(r.MsgID));
      if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value);
    }
    return r.MsgID;
  }

  /**
   * Download the original bytes of an inbound image.
   *
   * The sync message carries MsgId (and sometimes MediaId in the <img> XML).
   * The web client's own flow for a full image is:
   *   GET /cgi-bin/mmwebwx-bin/webwxgetmsgimg?MsgID=...&skey=...&mmweb_appid=...
   * with no `type` parameter (`type=slave` is only the thumbnail). If the
   * server refuses that, fall back to webwxgetmedia on the file host with the
   * message's MediaId.
   */
  async downloadImage({ msgId, mediaId, sender, encryFilename, filename, signal, maxBytes = 20 * 1024 * 1024 } = {}) {
    const id = msgId === undefined || msgId === null ? '' : String(msgId);
    const media = mediaId === undefined || mediaId === null ? '' : String(mediaId);
    const attempts = [];
    if (id) {
      attempts.push({
        base: this.creds.base,
        path: '/cgi-bin/mmwebwx-bin/webwxgetmsgimg',
        query: { MsgID: id, skey: this.creds.skey, mmweb_appid: this.creds.appId },
      });
      const fileBase = fileBaseFor(this.creds.base);
      if (fileBase !== this.creds.base) {
        attempts.push({
          base: fileBase,
          path: '/cgi-bin/mmwebwx-bin/webwxgetmsgimg',
          query: { MsgID: id, skey: this.creds.skey, mmweb_appid: this.creds.appId },
        });
      }
    }
    if (media) {
      attempts.push({
        base: fileBaseFor(this.creds.base),
        path: '/cgi-bin/mmwebwx-bin/webwxgetmedia',
        query: {
          sender: sender || '',
          mediaid: media,
          encryfilename: encryFilename || filename || '',
          fromuser: this.creds.uin,
          pass_ticket: this.creds.passTicket,
          webwx_data_ticket: cookieValue(this.creds.cookie, 'webwx_data_ticket'),
          mmweb_appid: this.creds.appId,
          sid: this.creds.sid,
          msgid: id,
        },
      });
    }
    if (!attempts.length) throw new WebWxError('downloadImage 需要 MsgID 或 MediaId', 'image_invalid');
    let lastError;
    for (const attempt of attempts) {
      try {
        const bytes = await this.requestBuffer(attempt.path, {
          base: attempt.base,
          query: attempt.query,
          signal,
          maxBytes,
        });
        if (bytes.length) return bytes;
        lastError = new WebWxError('图片下载返回空内容', 'image_empty');
      } catch (error) {
        lastError = error;
        this.log('image download attempt failed (' + attempt.path + '): ' + (error && error.message ? error.message : error));
      }
    }
    throw lastError || new WebWxError('图片下载失败', 'image_download_failed');
  }

  // 退出登录必须通知微信服务器；只停本地长轮询的话，手机上的「文件传输助手网页版」会一直显示连接。
  // 请求与官方前端 main bundle 的 webwxlogout 一致：skey 在 query，sid/uin 在 JSON body，appid 在 header。
  async logout() {
    try {
      await this.request('/cgi-bin/mmwebwx-bin/webwxlogout', {
        method: 'POST',
        query: { redirect: 1, type: 0, skey: this.creds.skey },
        body: { sid: this.creds.sid, uin: Number(this.creds.uin) },
        raw: true,
        signal: AbortSignal.timeout(8000),
      });
      this.log('已通知微信服务器退出登录');
      return true;
    } catch (e) {
      this.log('通知微信服务器退出登录失败: ' + e.message);
      return false;
    }
  }

  async run({ signal, onMessage, onError } = {}) {
    let backoff = 1000;
    let nonZeroCount = 0;
    while (!signal?.aborted) {
      let c;
      try {
        c = await this.syncCheck({ signal });
      } catch (e) {
        if (signal?.aborted) return;
        onError?.(e);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 15000);
        continue;
      }
      backoff = 1000;
      if (c.retcode === '1100' || c.retcode === '1101') {
        throw new WebWxError(
          c.retcode === '1100' ? '已在手机上退出登录' : '在另一台设备登录了文件传输助手',
          c.retcode
        );
      }
      if (c.retcode === '1102') {
        throw new WebWxError('微信登录态已过期，请重新扫码', c.retcode);
      }
      if (c.retcode !== '0') {
        nonZeroCount += 1;
        // 连续返回异常 retcode（如 synckey 漂移）时尝试重新 init 刷新 syncKey；若凭证本身已失效则抛出结束会话。
        if (nonZeroCount >= 3) {
          nonZeroCount = 0;
          try {
            await this.init();
            continue;
          } catch (e) {
            if (signal?.aborted) return;
            throw new WebWxError('微信同步恢复失败: ' + e.message, e.code || c.retcode);
          }
        }
        await sleep(800);
        continue;
      }
      nonZeroCount = 0;
      if (c.selector === '0') continue;
      let msgs;
      try {
        msgs = await this.sync({ signal });
      } catch (e) {
        if (signal?.aborted) return;
        onError?.(e);
        await sleep(800);
        continue;
      }
      for (const raw of msgs) await onMessage?.(normalize(raw));
    }
  }
}
