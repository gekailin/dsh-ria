import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import {
  managerPrompt,
  normalizeStyleSettings,
  STYLE_PRESETS,
  STYLE_PRESET_PROMPTS,
  STYLE_SETTINGS_DEFAULTS,
  voicePrompt,
} from '../lib/index.js'
import { createFixture } from './support/ria-fixture.mjs'

const BOUNDARIES = [
  '这套风格只作用于你写给用户的自然语言',
  '不改变：工具调用与参数、术语约定（工单/字段名）、必报项（数字、commit、路径、卡点、下一步、待用户拍板的问题）、note ≤500 字、安全与重启规则。',
  '风格是包装层，内容契约优先：不为简短省略必报项，不为语气添加无信息客套。',
]

// Normalisation keeps exactly three fields, falls back to concise, and truncates
// by code point so a 301-character custom string becomes 300 characters.
assert.deepEqual(normalizeStyleSettings(undefined), { enabled: false, preset: 'concise', custom: '' })
assert.deepEqual(
  normalizeStyleSettings({ enabled: true, preset: 'formal', custom: ' 多用动词 ', extra: 'dropped' }),
  { enabled: true, preset: 'formal', custom: ' 多用动词 ' },
)
assert.deepEqual(normalizeStyleSettings({ enabled: 'true', preset: 'reporter' }), { enabled: false, preset: 'concise', custom: '' })
assert.deepEqual(normalizeStyleSettings({ enabled: 1, preset: 'warm' }), { enabled: false, preset: 'warm', custom: '' })
assert.equal(normalizeStyleSettings({ custom: '字'.repeat(320) }).custom, '字'.repeat(300))
assert.equal(normalizeStyleSettings({ custom: 42 }).custom, '42')
assert.equal(STYLE_PRESETS.length, 4)
assert.deepEqual([...STYLE_PRESETS], ['concise', 'warm', 'formal', 'playful'])
assert.equal(STYLE_SETTINGS_DEFAULTS.enabled, false)
assert.equal(STYLE_SETTINGS_DEFAULTS.preset, 'concise')

// The settings card exposes the same four presets as the server, saves custom
// text explicitly, and keeps the disabled controls inert without hiding them.
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const block = clientSource.slice(clientSource.indexOf('/* voice-style:start */'), clientSource.indexOf('/* voice-style:end */'))
const client = new Function(block + '; return { VOICE_PRESETS, VOICE_UI_DEFAULTS, voicePresetValue, voiceCustomLength, voiceCustomClamp }')()
assert.deepEqual(client.VOICE_PRESETS.map(item => item.id), [...STYLE_PRESETS])
assert.deepEqual(client.VOICE_PRESETS.map(item => item.label), ['简洁', '温和', '严谨', '轻松'])
assert.equal(client.VOICE_UI_DEFAULTS.enabled, false)
assert.equal(client.voicePresetValue('formal'), 'formal')
assert.equal(client.voicePresetValue('angry'), 'concise')
assert.equal(client.voiceCustomLength('😀字'), 2)
assert.equal(client.voiceCustomClamp('字'.repeat(301)), '字'.repeat(300))
assert.match(clientSource, /"data-ria-style-enabled": "1"/)
assert.match(clientSource, /"data-ria-style-presets": "1"/)
assert.match(clientSource, /"data-ria-style-custom": "1"/)
assert.match(clientSource, /"data-ria-style-count": "1"/)
assert.match(clientSource, /"data-ria-style-save": "1"/)
assert.match(clientSource, /var styleDirty = styleDraft !== String\(style\.custom \|\| ""\);/)
assert.match(clientSource, /onClick: function \(\) \{ saveStyle\(\{ custom: styleDraft \}\); \}/)
assert.doesNotMatch(clientSource, /onBlur: function \(\) \{\s*if \(styleDraft !== style\.custom\)/)
assert.ok(clientSource.indexOf('"data-ria-style": "section"') < clientSource.indexOf('"data-ria-reflection": "section"'))
assert.match(clientSource, /关闭时不注入任何提示词/)

// Off is byte-for-byte the old prompt: no heading, no preset text, no custom.
const base = managerPrompt('session-ria', 'likes terse replies')
const off = managerPrompt('session-ria', 'likes terse replies', { enabled: false, preset: 'warm', custom: '绝不外传的补充' })
assert.equal(off, base)
assert.doesNotMatch(off, /## Voice|## 说话风格|绝不外传的补充/)
for (const text of Object.values(STYLE_PRESET_PROMPTS)) {
  assert.doesNotMatch(off, new RegExp(text.split('\n')[0].slice(0, 8)))
}

for (const preset of STYLE_PRESETS) {
  const prompt = managerPrompt('session-ria', 'likes terse replies', { enabled: true, preset, custom: '多用动词' })
  assert.match(prompt, /## Voice/)
  assert.ok(prompt.includes(STYLE_PRESET_PROMPTS[preset]), preset + ' should include its own preset text')
  for (const line of BOUNDARIES) assert.ok(prompt.includes(line), preset + ' should include boundary: ' + line)
  assert.ok(prompt.indexOf('## Voice') < prompt.indexOf('## User memory'))
  assert.ok(prompt.indexOf('多用动词') > prompt.indexOf('风格是包装层'))
  assert.match(prompt, /note ≤500 字/)
  assert.doesNotMatch(prompt, /## 说话风格/)
}

const noCustom = managerPrompt('session-ria', '', { enabled: true, preset: 'concise' })
assert.doesNotMatch(noCustom, /用户在预设之上追加的要求/)
assert.equal(voicePrompt({ enabled: false, preset: 'formal', custom: 'x' }), '')
assert.match(voicePrompt({ enabled: true, preset: 'formal' }), /^\n## Voice\n/)

function request(route, method, path, payload) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = { host: '127.0.0.1:3080' }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(body) { this.body = body; this.done(body) },
  }
  const done = new Promise(resolve => { res.done = resolve })
  route.handler(req, res)
  setImmediate(() => {
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
  })
  return done.then(body => ({ status: res.statusCode, body: JSON.parse(body) }))
}

const fixture = await createFixture({ prefix: 'ria-voice-style-' })
const api = (method, path, payload) => request(fixture.routes[0], method, path, payload)
try {
  const initial = await api('GET', '/plugins/dsh-ria/api/settings')
  assert.equal(initial.status, 200)
  assert.deepEqual(initial.body.style, { ...STYLE_SETTINGS_DEFAULTS, effectiveText: '' })
  assert.equal(initial.body.style.effectiveText, '')

  const invalid = [
    [{ style: [] }, 'body.style must be a JSON object'],
    [{ style: { enabled: 'yes' } }, 'body.style.enabled must be a boolean'],
    [{ style: { preset: 'angry' } }, 'body.style.preset must be one of'],
    [{ style: { custom: 42 } }, 'body.style.custom must be a string'],
    [{ style: { custom: '字'.repeat(301) } }, 'body.style.custom must be at most 300 characters'],
    [{ style: {} }, 'body.style must be provided'],
  ]
  for (const [payload, expected] of invalid) {
    const result = await api('POST', '/plugins/dsh-ria/api/settings', payload)
    assert.equal(result.status, 400, JSON.stringify(payload))
    assert.match(result.body.error, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  const unchanged = await api('GET', '/plugins/dsh-ria/api/settings')
  assert.deepEqual(unchanged.body.style, { ...STYLE_SETTINGS_DEFAULTS, effectiveText: '' })

  const enabled = await api('POST', '/plugins/dsh-ria/api/settings', { style: { enabled: true, preset: 'playful', ignored: true } })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.body.style.enabled, true)
  assert.equal(enabled.body.style.preset, 'playful')
  assert.equal(enabled.body.style.custom, '')
  assert.equal(enabled.body.style.ignored, undefined)
  assert.ok(enabled.body.style.effectiveText.includes(STYLE_PRESET_PROMPTS.playful))
  assert.match(enabled.body.style.effectiveText, /## Voice/)

  const custom = await api('POST', '/plugins/dsh-ria/api/settings', { style: { custom: '可以更直接' } })
  assert.equal(custom.status, 200)
  assert.equal(custom.body.style.enabled, true)
  assert.equal(custom.body.style.preset, 'playful')
  assert.equal(custom.body.style.custom, '可以更直接')
  assert.match(custom.body.style.effectiveText, /用户在预设之上追加的要求（冲突时以内容契约为先）：可以更直接/)

  const mixed = await api('POST', '/plugins/dsh-ria/api/settings', { reflection: { time: '22:10' }, style: { preset: 'formal' } })
  assert.equal(mixed.status, 200)
  assert.equal(mixed.body.reflection.time, '22:10')
  assert.equal(mixed.body.style.preset, 'formal')
  assert.equal(mixed.body.style.enabled, true)

  const disabled = await api('POST', '/plugins/dsh-ria/api/settings', { style: { enabled: false } })
  assert.equal(disabled.status, 200)
  assert.equal(disabled.body.style.effectiveText, '')
  assert.equal(disabled.body.style.preset, 'formal')
  assert.equal(disabled.body.style.custom, '可以更直接')
  assert.deepEqual(fixture.service.store.styleSettings(), { enabled: false, preset: 'formal', custom: '可以更直接' })
} finally {
  fixture.cleanup()
}

console.log('voice-style ok')
