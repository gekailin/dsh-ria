#!/usr/bin/env node
// 扫码登录 filehelper.weixin.qq.com，导出 creds.json。
// 和 wx.qq.com 无关：这是微信官方的「文件传输助手网页版」，独立 appid。
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  WebWxClient,
  UA,
  FILEHELPER_APPID,
  FILEHELPER_BASE,
  FILEHELPER_LOGIN,
  sleep,
} from './wxweb.mjs';

const tag = (xml, name) =>
  new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(xml)?.[1] ?? '';

function openFile(p) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', p] : [p];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 开始一次扫码登录：取 uuid 和二维码后立刻返回，轮询在后台继续。
 * 调用方拿 qr（JPEG Buffer）展示，用 status() 读当前阶段，用 done 等最终 creds。
 */
export async function beginLogin({
  loginBase = FILEHELPER_LOGIN,
  base = FILEHELPER_BASE,
  appId = FILEHELPER_APPID,
  pollMs = 1500,
  maxWaitMs = 180000,
  signal,
  onStatus = () => {},
} = {}) {
  const headers = { 'User-Agent': UA, Referer: base + '/' };
  const redirect = encodeURIComponent(base + '/cgi-bin/mmwebwx-bin/webwxnewloginpage');

  const js = await (
    await fetch(
      loginBase + '/jslogin?appid=' + appId + '&redirect_uri=' + redirect + '&fun=new&lang=zh_CN&_=' + Date.now(),
      { headers, ...(signal ? { signal } : {}) }
    )
  ).text();
  const uuid = /uuid\s*=\s*"([^"]+)"/.exec(js)?.[1];
  if (!uuid) throw new Error('jslogin 失败: ' + js.slice(0, 160));

  const qrUrl = loginBase + '/qrcode/' + uuid;
  const qr = await fetch(qrUrl, { headers, ...(signal ? { signal } : {}) });
  if (!qr.ok) throw new Error('取二维码失败 HTTP ' + qr.status);
  const qrBuffer = Buffer.from(await qr.arrayBuffer());

  let phase = 'waiting';
  let message = '请使用手机微信扫码';
  const update = (next, text) => {
    phase = next;
    message = text;
    onStatus(text, next);
  };

  const done = (async () => {
    const started = Date.now();
    let lastCode = '';
    while (Date.now() - started < maxWaitMs) {
      if (signal?.aborted) {
        const error = new Error('扫码已取消');
        error.code = 'aborted';
        throw error;
      }
      const text = await (
        await fetch(
          loginBase +
            '/cgi-bin/mmwebwx-bin/login?loginicon=true&uuid=' + encodeURIComponent(uuid) +
            '&tip=0&r=' + ~Date.now() + '&_=' + Date.now(),
          { headers, ...(signal ? { signal } : {}) }
        )
      ).text();
      const code = /window\.code\s*=\s*(\d+)/.exec(text)?.[1];

      if (code === '201') {
        if (lastCode !== '201') update('scanned', '已扫码，请在手机上点「确认登录」');
        lastCode = '201';
      } else if (code === '200') {
        const redirectUri = /redirect_uri\s*=\s*"([^"]+)"/.exec(text)?.[1];
        if (!redirectUri) throw new Error('登录成功但没拿到 redirect_uri');
        update('starting', '正在完成登录');
        return await finishLogin({ redirectUri, base, appId, headers, signal, onStatus });
      } else if (code === '400') {
        const error = new Error('二维码已失效，请重新获取');
        error.code = 'expired';
        throw error;
      }
      await sleep(pollMs);
    }
    const error = new Error('等待扫码超时，请重新获取二维码');
    error.code = 'timeout';
    throw error;
  })();
  // 调用方可能先返回 HTTP 响应再等 done；这里兜住后台拒绝，避免 unhandled rejection。
  done.catch(() => {});

  return { uuid, qrUrl, qr: qrBuffer, done, status: () => ({ phase, message }) };
}

/** 旧的阻塞式登录：拿到二维码后写文件，然后等用户扫码完成。 */
export async function login({
  qrPath = '.cache/qr.jpg',
  open = false,
  onQr = () => {},
  ...options
} = {}) {
  const flow = await beginLogin(options);
  await mkdir(dirname(qrPath), { recursive: true });
  await writeFile(qrPath, flow.qr);
  if (open) openFile(qrPath);
  onQr(flow.qrUrl, qrPath);
  return await flow.done;
}

async function finishLogin({ redirectUri, base, appId, headers, signal, onStatus }) {
  const url = new URL(redirectUri);
  url.searchParams.set('fun', 'new');
  url.searchParams.set('version', 'v2');
  const res = await fetch(url, { headers: { ...headers, mmweb_appid: appId }, ...(signal ? { signal } : {}) });
  const xml = await res.text();
  const ret = tag(xml, 'ret');
  if (ret && ret !== '0') throw new Error('webwxnewloginpage 失败 ret=' + ret + ': ' + xml.slice(0, 160));

  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

  const creds = {
    base,
    appId,
    cookie,
    uin: tag(xml, 'wxuin'),
    sid: tag(xml, 'wxsid'),
    skey: tag(xml, 'skey'),
    passTicket: tag(xml, 'pass_ticket'),
    deviceid: String(Math.random()).slice(2, 17),
  };
  if (!creds.uin || !creds.sid || !creds.passTicket) {
    throw new Error('登录响应缺字段: ' + xml.slice(0, 200));
  }

  const client = new WebWxClient(creds);
  const init = await client.init();
  onStatus('登录成功: ' + init.User.NickName);
  return { creds, user: init.User, syncKey: init.SyncKey };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    out[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = args.out || 'creds.json';
  const { creds, user } = await login({
    loginBase: args['login-base'],
    base: args.base,
    qrPath: args.qr || '.cache/qr.jpg',
    open: args.open !== false && args.open !== 'false',
    onQr: (url, file) => {
      console.log('二维码已保存: ' + file);
      console.log('备用地址: ' + url);
      console.log('用手机微信扫码 → 确认登录');
    },
    onStatus: (s) => console.log(s),
  });
  await writeFile(out, JSON.stringify(creds, null, 2) + '\n');
  console.log('已写入 ' + out + '（' + user.NickName + '）');
  console.log('下一步: node src/cli.mjs --creds ' + out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('登录失败:', e.message);
    process.exit(1);
  });
}
