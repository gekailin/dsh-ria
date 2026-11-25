import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadReflectionSettings() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('/* reflection-settings:start */')
  const end = source.indexOf('/* reflection-settings:end */')
  assert.ok(start >= 0 && end > start, 'client reflection settings markers')
  const block = source.slice(start, end)
  const api = new Function(block + '\nreturn { reflectionToday, reflectionWeekdayLabel, reflectionStatusLabel, reflectionCadenceSummary, REFLECTION_UI_DEFAULTS, REFLECTION_WEEKDAYS };')()
  return { source, ...api }
}

const { source, reflectionToday, reflectionWeekdayLabel, reflectionStatusLabel, reflectionCadenceSummary, REFLECTION_UI_DEFAULTS, REFLECTION_WEEKDAYS } = loadReflectionSettings()

assert.deepEqual(REFLECTION_UI_DEFAULTS, {
  enabled: false,
  cadence: 'daily',
  time: '23:40',
  weekday: 1,
})
for (const key of ['model', 'provider', 'reasoningEffort']) {
  assert.equal(Object.hasOwn(REFLECTION_UI_DEFAULTS, key), false, 'removed reflection model field: ' + key)
}
assert.deepEqual(REFLECTION_WEEKDAYS.map(item => item.value), [1, 2, 3, 4, 5, 6, 7])
assert.deepEqual(REFLECTION_WEEKDAYS.map(item => item.label), ['周一', '周二', '周三', '周四', '周五', '周六', '周日'])
assert.equal(reflectionWeekdayLabel(1), '周一')
assert.equal(reflectionWeekdayLabel(3), '周三')
assert.equal(reflectionWeekdayLabel(99), '周一')

assert.equal(reflectionToday(Date.UTC(2026, 10, 14, 15, 59)), '2026-11-14')
assert.equal(reflectionToday(Date.UTC(2026, 10, 14, 16, 0)), '2026-11-15')
assert.equal(reflectionToday(Date.UTC(2026, 0, 1, 0, 0)), '2026-01-01')

assert.equal(reflectionStatusLabel('complete'), '完成')
assert.equal(reflectionStatusLabel('partial'), '部分完成')
assert.equal(reflectionStatusLabel('failed'), '失败')
assert.equal(reflectionStatusLabel('timed_out'), '超时')
assert.equal(reflectionStatusLabel('cancelled'), '已取消')
assert.equal(reflectionStatusLabel('starting'), '启动中')
assert.equal(reflectionStatusLabel('running'), '运行中')
assert.equal(reflectionStatusLabel(null), '暂无记录')

assert.equal(reflectionCadenceSummary({ cadence: 'daily', time: '23:40', weekday: 1 }),
  '每天 23:40 启动一个独立的 executor 做反思。默认关闭。')
assert.equal(reflectionCadenceSummary({ cadence: 'weekly', time: '09:05', weekday: 3 }),
  '每周三 09:05 启动一个独立的 executor 做反思。默认关闭。')
assert.equal(reflectionCadenceSummary({ cadence: 'daily', time: '23:40', weekday: 7 }),
  '每天 23:40 启动一个独立的 executor 做反思。默认关闭。')

assert.match(source, /"data-ria-reflection": "section"/)
assert.match(source, /data-ria-reflection-enabled/)
assert.match(source, /data-ria-reflection-cadence/)
assert.match(source, /data-ria-reflection-weekday/)
assert.match(source, /data-ria-reflection-time/)
assert.doesNotMatch(source, /data-ria-reflection-advanced/)
assert.doesNotMatch(source, /data-ria-reflection-field/)
assert.doesNotMatch(source, /data-ria-reflection-model|reflection\.model/)
assert.match(source, /data-ria-reflection-run/)
assert.match(source, /data-ria-reflection-status/)
assert.match(source, /"定期反思"/)
assert.match(source, /"现在启动"/)
assert.match(source, /反思进行中…/)
assert.match(source, /今天已完成，仍要再跑一次？/)
assert.match(source, /api\("\/reflection\/run", "POST"/)
assert.match(source, /api\("\/reflection\/status"\)/)
assert.match(source, /setInterval\(function \(\) \{ refreshReflectionStatus\(\); \}, 10000\)/)
assert.match(source, /clearInterval\(timer\)/)
assert.match(source, /saveReflection\("enabled", \{ enabled: event\.target\.checked \}\)/)
assert.match(source, /saveReflection\("cadence", \{ cadence: event\.target\.value \}\)/)
assert.match(source, /saveReflection\("weekday", \{ weekday: Number\(event\.target\.value\) \}\)/)
assert.match(source, /saveReflection\("time", \{ time: value \}\)/)
assert.match(source, /reflectionStatusView\.scheduleError/)
assert.match(source, /reflectionStatusView\.lastError/)

console.log('reflection-settings-ui ok')
