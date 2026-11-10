// 微信「文件传输助手网页版」协议客户端（wenjian.weixin.qq.com）。
// 它在协议上和 wx.qq.com 同源同构，但独立 appid：wx_webfilehelper，
// 且不受「网页版微信」的登录限制——只做 filehelper 一个会话。
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
