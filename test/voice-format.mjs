import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'
import { clipStructuredText } from '../lib/core/shared.mjs'

// Structure-preserving clip: under-limit text is byte-for-byte unchanged.
const multiline = '定位：先给结论。\n\n- 第一项\n- 第二项'
assert.equal(clipStructuredText(multiline, 500), multiline)
assert.equal(clipStructuredText('短句', 500), '短句')

// Over-limit semantic boundaries, never a half sentence.
const sentence = '甲'.repeat(40) + '。' + '乙'.repeat(100)
const clippedSentence = clipStructuredText(sentence, 50)
assert.ok(Array.from(clippedSentence).length <= 50)
assert.ok(clippedSentence.endsWith('。…'), clippedSentence)
assert.equal(clippedSentence.includes('乙'), false)

const clippedList = clipStructuredText('第一段。\n\n- 列表一\n- 列表二\n' + '长'.repeat(600), 60)
assert.ok(Array.from(clippedList).length <= 60)
assert.ok(clippedList.endsWith('…'))
assert.ok(clippedList.includes('\n- 列表一'), 'keeps the list newline if it is before the limit')

const fixture = await createFixture({ stateDefault: true })
try {
  const controller = fixture.service.controller
  const store = fixture.service.store

  // The settings round-trip keeps internal newlines; only storage cap applies.
  store.setSettings({ style: { enabled: true, preset: 'warm', custom: multiline } })
  assert.equal(store.settings().style.custom, multiline)
  assert.equal(fixture.service.settingsPayload().style.custom, multiline)

  const prompt = controller.chatSystemPrompt('BASE', {})
  const voice = prompt.slice(prompt.indexOf('[说话风格]'))
  assert.ok(voice.includes('定位：先给结论。\n\n- 第一项\n- 第二项'), voice)
  assert.ok(voice.includes('\n- 这套风格只作用于'), 'fixed boundary list stays on its own line')
  assert.equal(voice.includes('定位：先给结论。 - 第一项'), false, 'voice must not be flattened')

  // A full-length custom style is clipped at a structure boundary, not mid-sentence.
  store.setSettings({
    style: { enabled: true, custom: '定位：先给结论。\n\n- A\n- B\n' + '长'.repeat(300) },
  })
  const longPrompt = controller.chatSystemPrompt('BASE', {})
  const voiceStart = longPrompt.indexOf('[说话风格]')
  const nextSection = longPrompt.indexOf('\n\n[', voiceStart + 1)
  const longVoice = longPrompt.slice(voiceStart, nextSection > voiceStart ? nextSection : undefined)
  const body = longVoice.split('\n').slice(1).join('\n')
  assert.ok(Array.from(body).length <= 500, 'voice body capped at 500')
  assert.ok(body.endsWith('…'), body.slice(-20))
  assert.equal(body.includes('\n- A\n- B'), true, 'list structure is preserved before truncation')
} finally {
  fixture.cleanup()
}

console.log('voice prompt format ok')
