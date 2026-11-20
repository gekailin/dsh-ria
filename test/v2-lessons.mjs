import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { V2Store } from '../lib/store/store.mjs'
import { LessonStore } from '../lib/store/lessons.mjs'
import { createFixture } from './support/ria-fixture.mjs'

// Lessons: Workers propose candidates, the Advisor reviews them, and dispatch
// injects only the matched ones into the Worker brief.

const repo = '/home/gkl/Desktop/vibe_proj/dsh-ria'

async function planned(fixture, chatbot, request, advisor) {
  const plan = await fixture.callAs(advisor, 'ticket_plan', {
    ticketId: request.ticketId,
    summary: 'do the ticket',
    steps: ['step one'],
    ...(request.lessons ? { lessons: request.lessons } : {}),
  })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  return plan
}

// ① + ② candidates, review, dedupe, reject.
{
  const fixture = await createFixture({ v2Default: true })
  try {
    const chatbot = fixture.service.v2.v2.chatSessionId
    const request = await fixture.callAs(chatbot, 'chatbot_request', { goal: '改 v2 角色名', mode: 'work' })
    const advisor = fixture.service.v2.v2.advisor('global').sessionId
    await planned(fixture, chatbot, request, advisor)
    const dispatch = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: request.ticketId })
    assert.equal(dispatch.ok, true)
    const worker = dispatch.workerSessionId

    const reported = await fixture.callAs(worker, 'worker_report', {
      ticketId: request.ticketId,
      status: 'progress',
      summary: '半程',
      lessons: [
        { scenario: 'v2 改角色名', pitfall: '只改 controller 不改旧数据', approach: '加 normalize 别名', evidence: 'lib/tickets.mjs' },
        { scenario: 'fixture 工具面', pitfall: '夹具没挂 grep/glob', approach: '用 extraGlobalTools', evidence: 'test/support/ria-fixture.mjs' },
      ],
    })
    assert.equal(reported.ok, true)
    assert.equal(reported.lessonCandidates, 2)
    // Candidates are inert: the library file has no entries yet.
    assert.equal(fixture.service.v2.lessons.entries().length, 0)
    assert.equal(fixture.service.v2.lessons.stats().entries, 0)

    const listed = await fixture.callAs(advisor, 'lesson_review', { action: 'list' })
    assert.equal(listed.ok, true)
    assert.equal(listed.candidates.length, 2)
    assert.ok(listed.candidates.every(item => item.status === 'candidate' && item.ticketId === request.ticketId))

    const first = listed.candidates.find(item => item.scenario === 'v2 改角色名')
    const accepted = await fixture.callAs(advisor, 'lesson_review', { action: 'accept', id: first.id })
    assert.equal(accepted.ok, true, JSON.stringify(accepted))
    assert.equal(accepted.deduped, false)
    assert.equal(fixture.service.v2.lessons.entries().length, 1)
    const entryId = accepted.entryId
    assert.ok(String(entryId).startsWith('les_'))

    // Same scenario+pitfall, different approach and source: merge, not append.
    const again = await fixture.callAs(worker, 'worker_report', {
      ticketId: request.ticketId,
      status: 'progress',
      summary: '又踩了一次',
      lessons: [{ scenario: 'v2 改角色名', pitfall: '只改 controller 不改旧数据', approach: '加 normalize 别名 + 迁移测试锁住' }],
    })
    assert.equal(again.lessonCandidates, 1)
    const candidates = (await fixture.callAs(advisor, 'lesson_review', { action: 'list' })).candidates
    const duplicate = candidates.find(item => item.id !== first.id && item.status === 'candidate' && item.scenario === 'v2 改角色名')
    assert.ok(duplicate, 'expected the duplicate candidate')
    const merged = await fixture.callAs(advisor, 'lesson_review', { action: 'accept', id: duplicate.id })
    assert.equal(merged.ok, true)
    assert.equal(merged.deduped, true)
    assert.equal(merged.entryId, entryId)
    assert.equal(fixture.service.v2.lessons.entries().length, 1)
    const mergedEntry = fixture.service.v2.lessons.get(entryId)
    assert.match(mergedEntry.approach, /迁移测试锁住/)
    assert.equal(mergedEntry.source.ticketId, request.ticketId)
    assert.equal(mergedEntry.source.sessionId, worker)

    // Reject keeps the library untouched.
    const rejected = await fixture.callAs(advisor, 'lesson_review', { action: 'reject', id: candidates.find(item => item.scenario === 'fixture 工具面').id })
    assert.equal(rejected.ok, true)
    assert.equal(fixture.service.v2.lessons.entries().length, 1)
    assert.equal(fixture.service.v2.v2.lessonCandidates({ status: 'rejected' }).length, 1)
  } finally {
    fixture.cleanup()
  }
}

// ③ + ④ search, pinned and auto-matched injection, no-lesson dispatch.
{
  const fixture = await createFixture({ v2Default: true, extraGlobalTools: ['grep', 'glob'] })
  try {
    const chatbot = fixture.service.v2.v2.chatSessionId
    const lessons = fixture.service.v2.lessons
    const seeded = lessons.accept({
      scenario: 'v2 改角色名要同步 ria.json 旧字段兼容',
      pitfall: '只改 controller 会漏掉旧数据',
      approach: '加 normalize 别名并在加载时迁移',
      condition: 'dsh-ria 仓库里做角色改名',
      tags: ['v2', 'rename', 'dsh-ria'],
      source: { ticketId: 'ticket_old', sessionId: 'session_old' },
    })
    const lessonId = seeded.entry.id
    lessons.accept({
      scenario: '微信长轮询断线',
      pitfall: '重连时丢游标',
      approach: '把 cursor 落盘并在启动时重放',
      tags: ['wechat', 'channel'],
      source: { ticketId: 'ticket_wechat', sessionId: 'session_wechat' },
    })

    // Advisor search hits the rename lesson, not the unrelated one.
    const request = await fixture.callAs(chatbot, 'chatbot_request', {
      goal: '把 v2 角色名从 thinker 改成 advisor，兼容旧数据',
      workspace: repo,
      mode: 'work',
    })
    const advisor = fixture.service.v2.v2.advisor('global').sessionId
    const search = await fixture.callAs(advisor, 'lesson_search', {
      query: '角色改名 v2 旧字段兼容',
      workspace: repo,
      mode: 'work',
    })
    assert.equal(search.ok, true)
    assert.equal(search.lessons[0].id, lessonId)
    assert.ok(search.scanned < 2, 'scanned should follow postings, got ' + search.scanned)

    // Pin it explicitly in the WorkOrder, then dispatch.
    await planned(fixture, chatbot, { ...request, lessons: [lessonId] }, advisor)
    const plan = fixture.service.v2.v2.workOrder(request.ticketId)
    assert.equal(plan.lessons[0].id, lessonId)
    const dispatch = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: request.ticketId })
    assert.equal(dispatch.ok, true, JSON.stringify(dispatch))
    assert.deepEqual(dispatch.lessons, [lessonId])
    const brief = fixture.prompts.filter(item => item.sessionId === dispatch.workerSessionId).at(-1).content[0].text
    assert.match(brief, /\[Lessons\]/)
    assert.match(brief, new RegExp(lessonId))
    const meta = fixture.service.v2.v2.ticketMeta(request.ticketId)
    assert.deepEqual(meta.usedLessons, [lessonId])
    assert.equal(fixture.service.v2.lessons.get(lessonId).hits, 1)
    if (process.env.RIA_LESSONS_DEMO === '1') {
      console.log('--- demo brief excerpt ---')
      console.log(brief.split('\n').filter(line => /Lessons|les_/.test(line)).join('\n'))
      console.log('--- usedLessons: ' + JSON.stringify(meta.usedLessons) + ' ---')
    }

    // Auto-match path: no pinned ids, the ticket goal alone finds the lesson.
    const autoRequest = await fixture.callAs(chatbot, 'chatbot_request', {
      goal: '改 v2 角色名并兼容 ria.json 旧字段',
      workspace: repo,
      mode: 'work',
    })
    await planned(fixture, chatbot, autoRequest, advisor)
    const autoDispatch = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: autoRequest.ticketId })
    assert.equal(autoDispatch.ok, true, JSON.stringify(autoDispatch))
    assert.ok(autoDispatch.lessons.includes(lessonId), JSON.stringify(autoDispatch.lessons))
    const autoBrief = fixture.prompts.filter(item => item.sessionId === autoDispatch.workerSessionId).at(-1).content[0].text
    assert.match(autoBrief, /\[Lessons\]/)
    assert.match(autoBrief, new RegExp(lessonId))

    // Nothing relevant: no section, no error, explicit empty list.
    const unrelatedRequest = await fixture.callAs(chatbot, 'chatbot_request', { goal: '写一个纯文本总结', acceptance: 'x', mode: 'work' })
    await planned(fixture, chatbot, unrelatedRequest, advisor)
    const unrelatedDispatch = await fixture.callAs(advisor, 'ticket_dispatch', { ticketId: unrelatedRequest.ticketId })
    assert.equal(unrelatedDispatch.ok, true, JSON.stringify(unrelatedDispatch))
    assert.deepEqual(unrelatedDispatch.lessons, [])
    const unrelatedBrief = fixture.prompts.filter(item => item.sessionId === unrelatedDispatch.workerSessionId).at(-1).content[0].text
    assert.equal(/\[Lessons\]/.test(unrelatedBrief), false)
    assert.deepEqual(fixture.service.v2.v2.ticketMeta(unrelatedRequest.ticketId).usedLessons, [])
  } finally {
    fixture.cleanup()
  }
}

// ⑤ Old v2.json without the candidate field loads cleanly.
{
  const dir = mkdtempSync(join(tmpdir(), 'ria-lessons-compat-'))
  try {
    writeFileSync(join(dir, 'v2.json'), JSON.stringify({
      schemaVersion: 1,
      chatSessionId: null,
      advisors: {},
      workers: {},
      requests: {},
      tickets: {},
      workOrders: {},
      reports: [],
      inbox: [],
      lastError: null,
    }))
    const store = new V2Store(dir)
    assert.deepEqual(store.lessonCandidates({ status: '' }), [])
    assert.equal(store.lessonCandidate('nope'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ⑥ The match cost follows the postings, not the library size.
{
  const dir = mkdtempSync(join(tmpdir(), 'ria-lessons-index-'))
  try {
    const store = new LessonStore({ stateDir: dir })
    for (let index = 0; index < 100; index += 1) {
      store.accept({
        scenario: 'bulk scenario ' + index + ' unique' + index,
        pitfall: 'bulk pitfall ' + index,
        approach: 'bulk approach ' + index,
        tags: ['bulk'],
        source: { ticketId: 'ticket_' + index, sessionId: 'session_' + index },
      })
    }
    assert.equal(store.entries().length, 100)
    // Sources and hit counts merge when the same scene+pitfall comes back from
    // another ticket.
    const mergeA = store.accept({ scenario: 'merge scene', pitfall: 'merge pit', approach: 'first', source: { ticketId: 't1', sessionId: 's1' } })
    const mergeB = store.accept({ scenario: 'merge scene', pitfall: 'merge pit', approach: 'second', hits: 2, source: { ticketId: 't2', sessionId: 's2' } })
    assert.equal(mergeB.deduped, true)
    assert.equal(mergeA.entry.id, mergeB.entry.id)
    const merged = store.get(mergeA.entry.id)
    assert.deepEqual(merged.sources.map(item => item.ticketId).sort(), ['t1', 't2'])
    assert.equal(merged.hits, 2)
    assert.equal(merged.approach, 'second')
    const matched = store.match({ goal: 'unique42' })
    assert.equal(matched.lessons.length, 1)
    assert.ok(matched.scanned < 100, 'scanned=' + matched.scanned)
    // The index file is a real, readable JSON document.
    const raw = JSON.parse(readFileSync(join(dir, 'lessons.json'), 'utf8'))
    assert.equal(Object.keys(raw.entries).length, 101)
    assert.equal(raw.schemaVersion, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ⑦ A leftover temp file from an earlier failed write cannot poison every retry.
{
  const dir = mkdtempSync(join(tmpdir(), 'ria-lessons-stale-temp-'))
  try {
    const file = join(dir, 'lessons.json')
    const legacyTemp = file + '.tmp-' + process.pid
    writeFileSync(legacyTemp, 'unrelated leftover; do not overwrite or delete')
    const store = new LessonStore({ stateDir: dir })
    assert.equal(store.save(), true, 'a stale PID temp must not block a new save')
    assert.equal(store.save(), true, 'later retries stay usable')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 1)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(readFileSync(legacyTemp, 'utf8'), 'unrelated leftover; do not overwrite or delete')
    assert.deepEqual(readdirSync(dir).sort(), ['lessons.json', 'lessons.json.tmp-' + process.pid].sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ⑧ A failed atomic rename cleans only its own temp and preserves the old file.
{
  const dir = mkdtempSync(join(tmpdir(), 'ria-lessons-rename-failure-'))
  try {
    const warnings = []
    const store = new LessonStore({ stateDir: dir, log: (level, message) => warnings.push({ level, message }) })
    assert.equal(store.save(), true)
    const file = store.file
    const before = readFileSync(file, 'utf8')
    const blockedTarget = join(dir, 'blocked-target')
    mkdirSync(blockedTarget)
    store.file = blockedTarget
    assert.equal(store.save(), false, 'rename onto a directory must fail visibly')
    assert.ok(warnings.some(item => item.level === 'warn' && item.message.includes('could not write')))
    assert.deepEqual(readdirSync(dir).sort(), ['blocked-target', 'lessons.json'], 'failed attempt leaves no owned temp')
    assert.equal(readFileSync(file, 'utf8'), before, 'the existing library stays intact')
    store.file = file
    assert.equal(store.save(), true, 'saving recovers after the target failure is resolved')
    assert.deepEqual(readdirSync(dir).sort(), ['blocked-target', 'lessons.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('v2 lessons ok')
