import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_MARKDOWN_FILE_OPTIONS,
  decideMarkdownFile,
  markdownFileName,
  normalizeMarkdownFileOptions,
} from '../lib/wechat/markdown.mjs'
import { Outbound } from '../lib/wechat/outbound.mjs'
import { WechatService } from '../lib/wechat/service.mjs'
import { WebWxClient } from '../lib/wechat/wxweb.mjs'

const wait = () => new Promise(resolve => setTimeout(resolve, 0))

function fakeCtx() {
  return {
    on() { return () => {} },
    sessionController: { async prompt() { return { accepted: true } } },
  }
}

function makeService(ctx, dir, overrides = {}) {
  return new WechatService({
    ctx,
    stateDir: dir,
    ensureSuper: async () => 'session-12345678',
    getSuperId: () => 'session-12345678',
    markdownFile: { enabled: true, charThreshold: 80, codeBlock: true, table: true, headingCount: 4, linkCount: 6 },
    ...overrides,
  })
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-super-session-wechat-file-'))
try {
  assert.equal(DEFAULT_MARKDOWN_FILE_OPTIONS.charThreshold, 800)
  assert.equal(normalizeMarkdownFileOptions(false).enabled, false)
  assert.deepEqual(normalizeMarkdownFileOptions({ charThreshold: 10 }), {
    ...DEFAULT_MARKDOWN_FILE_OPTIONS,
    charThreshold: 80,
  })
  assert.equal(normalizeMarkdownFileOptions({}, {
    DSH_SUPER_SESSION_MD_FILE: '0',
    DSH_SUPER_SESSION_MD_THRESHOLD: '5000',
    DSH_SUPER_SESSION_MD_CODE: 'no',
    DSH_SUPER_SESSION_MD_TABLE: 'yes',
    DSH_SUPER_SESSION_MD_HEADINGS: '9',
    DSH_SUPER_SESSION_MD_LINKS: '2',
  }).enabled, false)
  assert.equal(normalizeMarkdownFileOptions({}, {
    DSH_SUPER_SESSION_MD_THRESHOLD: '5000',
    DSH_SUPER_SESSION_MD_HEADINGS: '9',
    DSH_SUPER_SESSION_MD_LINKS: '2',
  }).charThreshold, 5000)
  assert.equal(normalizeMarkdownFileOptions({}, {
    DSH_SUPER_SESSION_MD_HEADINGS: '9',
    DSH_SUPER_SESSION_MD_LINKS: '2',
  }).headingCount, 9)
  assert.equal(normalizeMarkdownFileOptions({}, {
    DSH_SUPER_SESSION_MD_LINKS: '2',
  }).linkCount, 2)

  assert.equal(decideMarkdownFile('short and simple', { charThreshold: 80 }).file, false)
  assert.equal(decideMarkdownFile('x'.repeat(81), { charThreshold: 80 }).file, true)
  assert.deepEqual(decideMarkdownFile('x'.repeat(81), { charThreshold: 80 }).reasons, ['length'])
  assert.equal(decideMarkdownFile('a\n\x60\x60\x60js\nconsole.log(1)\n\x60\x60\x60\nb', { charThreshold: 80 }).file, true)
  assert.deepEqual(decideMarkdownFile('a\n\x60\x60\x60js\nconsole.log(1)\n\x60\x60\x60\nb', { charThreshold: 80 }).reasons, ['code-block'])
  const table = '| a | b |\n| --- | --- |\n| 1 | 2 |'
  assert.equal(decideMarkdownFile(table, { charThreshold: 80 }).file, true)
  assert.deepEqual(decideMarkdownFile(table, { charThreshold: 80 }).reasons, ['table'])
  const headings = '# one\n## two\n### three\n#### four'
  assert.equal(decideMarkdownFile(headings, { charThreshold: 80 }).file, true)
  assert.deepEqual(decideMarkdownFile(headings, { charThreshold: 80 }).reasons, ['headings'])
  const links = '[1](a) [2](b) [3](c) [4](d) [5](e) [6](f)'
  assert.equal(decideMarkdownFile(links, { charThreshold: 80 }).file, true)
  assert.deepEqual(decideMarkdownFile(links, { charThreshold: 80 }).reasons, ['links'])
  assert.equal(decideMarkdownFile('x'.repeat(100), { charThreshold: 80, enabled: false }).file, false)
  assert.equal(markdownFileName('session-12345678', new Date(2026, 10, 11, 7, 30, 15)), 'super-12345678-20261111-073015.md')
  assert.equal(markdownFileName('', new Date(2026, 10, 11, 7, 30, 15)), 'super-super-20261111-073015.md')

  {
    const events = []
    const outbound = new Outbound({
      gapMs: 0,
      prefix: '',
      async send(text) { events.push(['text', text]); return 'text-id' },
      async sendFile(name, buffer, mime) { events.push(['file', name, buffer.toString(), mime]); return 'file-id' },
    })
    const results = await Promise.all([
      outbound.enqueue('before'),
      outbound.enqueueFile({ name: 'x.md', buffer: Buffer.from('# x') }),
      outbound.enqueue('after'),
    ])
    assert.deepEqual(results, ['text-id', 'file-id', 'text-id'])
    assert.deepEqual(events, [
      ['text', 'before'],
      ['file', 'x.md', '# x', 'text/markdown'],
      ['text', 'after'],
    ])
  }

  {
    const ctx = fakeCtx()
    const service = makeService(ctx, dir)
    const texts = []
    const files = []
    service.session = { client: { sentIds: new Set() } }
    service.outbound = {
      async enqueue(text) { texts.push(text); return 'text-id' },
      async enqueueFile(file) { files.push(file); return 'file-id' },
    }
    service.forwardAssistant('short reply')
    await wait()
    assert.deepEqual(texts, ['short reply'])
    assert.equal(files.length, 0)

    const long = 'x'.repeat(81)
    service.forwardAssistant(long)
    await wait()
    assert.equal(files.length, 1)
    assert.match(files[0].name, /^super-12345678-\d{8}-\d{6}\.md$/)
    assert.equal(files[0].mime, 'text/markdown')
    assert.equal(files[0].buffer.toString(), long)
    assert.match(texts[1], /已转为 Markdown 文件发送/)
  }

  {
    const ctx = fakeCtx()
    const service = makeService(ctx, dir)
    const texts = []
    service.session = { client: { sentIds: new Set() } }
    service.outbound = {
      async enqueue(text) { texts.push(text); return 'text-id' },
      async enqueueFile() { throw new Error('upload unavailable') },
    }
    const long = 'y'.repeat(81)
    service.forwardAssistant(long)
    await wait()
    assert.equal(texts.length, 2)
    assert.match(texts[0], /已转为 Markdown 文件发送/)
    assert.match(texts[1], /^（原回复已转为 Markdown 文件，但文件发送失败，以下改为文本）\n\n/)
    assert.equal(texts[1].endsWith(long), true)
  }

  {
    const ctx = fakeCtx()
    const service = makeService(ctx, dir)
    service.session = { client: { sentIds: new Set() } }
    service.outbound = {
      async enqueue() { throw new Error('text unavailable') },
      async enqueueFile() { throw new Error('upload unavailable') },
    }
    service.forwardAssistant('z'.repeat(81))
    await wait()
    assert.equal(service.state.data.outbox.length, 1)
    assert.equal(service.state.data.outbox[0].text, 'z'.repeat(81))
  }

  {
    const originalFetch = globalThis.fetch
    const requests = []
    const content = '# hello\n\nworld'
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), options })
      return new Response(JSON.stringify({ BaseResponse: { Ret: 0 }, MediaId: '@media-id', Signature: 'sig' }), { status: 200 })
    }
    try {
      const client = new WebWxClient({
        base: 'https://wenjian.weixin.qq.com',
        cookie: 'a=1; webwx_data_ticket=ticket-value',
        passTicket: 'a%2Bb',
        uin: '42',
        sid: 'sid',
        skey: 'skey',
      })
      client.self = { UserName: '@self' }
      let appmsg
      client.request = async (path, options) => {
        appmsg = { path, options }
        return { BaseResponse: { Ret: 0 }, MsgID: 'msg-file-1' }
      }
      const id = await client.sendFile('filehelper', {
        name: 'note.md',
        buffer: Buffer.from(content),
        mime: 'text/markdown',
      })
      assert.equal(id, 'msg-file-1')
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, 'https://file.wx.qq.com/cgi-bin/mmwebwx-bin/webwxuploadmedia?f=json')
      const form = requests[0].options.body
      assert.equal(form.get('name'), 'note.md')
      assert.equal(form.get('type'), 'text/markdown')
      assert.equal(form.get('size'), String(Buffer.byteLength(content)))
      assert.equal(form.get('chunks'), '1')
      assert.equal(form.get('webwx_data_ticket'), 'ticket-value')
      assert.equal(form.get('pass_ticket'), 'a+b')
      assert.equal(form.get('filename').name, 'note.md')
      const upload = JSON.parse(form.get('uploadmediarequest'))
      assert.equal(upload.FileMd5, createHash('md5').update(content).digest('hex'))
      assert.equal(upload.MediaType, 4)
      assert.equal(upload.ToUserName, 'filehelper')
      assert.equal(appmsg.path, '/cgi-bin/mmwebwx-bin/webwxsendappmsg')
      assert.equal(appmsg.options.query.fun, 'async')
      assert.equal(appmsg.options.body.Msg.Type, 6)
      assert.match(appmsg.options.body.Msg.Content, /<title>note\.md<\/title>/)
      assert.match(appmsg.options.body.Msg.Content, /<totallen>14<\/totallen>/)
      assert.match(appmsg.options.body.Msg.Content, /<attachid>@media-id<\/attachid>/)
      assert.match(appmsg.options.body.Msg.Content, /<fileext>md<\/fileext>/)
      assert.equal(appmsg.options.body.Msg.Signature, 'sig')
      assert.equal(client.sentIds.has('msg-file-1'), true)
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  console.log('wechat-file ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
