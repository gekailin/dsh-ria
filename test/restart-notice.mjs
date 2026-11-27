import assert from 'node:assert/strict'
import { createFixture } from './support/ria-fixture.mjs'

// The restart notice is a single Chat message driven by the boot marker:
// first boot stays silent, a different pid announces with both pids, a missing
// clean-exit flag is reported as an abnormal exit, and one process never sends
// twice. The event mirrors the same facts for the audit log.

const fixture = await createFixture({ stateDefault: true })
try {
  const service = fixture.service
  const controller = service.controller
  const notices = []
  controller.queueChatNotice = message => { notices.push(String(message)) }
  const restartEvents = () => service.routerEvents.query({ types: ['ria.restarted'], limit: 20 }).events

  // 1) First boot (no previous marker): nothing to announce.
  assert.equal(service.boot.classification.kind, 'first', 'the fixture starts with a fresh state directory')
  assert.equal(controller.announceRiaRestart({ recoveredTickets: 0, startupMs: 120 }), null)
  assert.equal(notices.length, 0)
  assert.equal(restartEvents().length, 0)

  // 2) Clean restart: one notice with both pids and the recovery facts.
  service.boot = {
    prev: { pid: 111111, startedAt: 1, cleanExit: true },
    current: { pid: 222222, startedAt: 2, cleanExit: false },
    classification: { kind: 'restart', reason: 'clean_restart' },
  }
  const cleanPayload = controller.announceRiaRestart({ recoveredTickets: 2, startupMs: 1234 })
  assert.equal(notices.length, 1, 'exactly one notice per process')
  assert.match(notices[0], /PID 111111 → 222222/)
  assert.match(notices[0], /正常重启/)
  assert.match(notices[0], /恢复工单 2 张/)
  assert.match(notices[0], /启动耗时 1\.2 s/)
  assert.equal(notices[0].includes('\n'), false, 'one self-contained line')
  assert.equal(cleanPayload.reason, 'clean_restart')
  // query() orders newest first.
  const cleanEvent = restartEvents()[0]
  assert.equal(cleanEvent.event, 'ria.restarted')
  assert.equal(cleanEvent.actor, 'system')
  assert.equal(cleanEvent.payload.prevPid, 111111)
  assert.equal(cleanEvent.payload.newPid, 222222)
  assert.equal(cleanEvent.payload.reason, 'clean_restart')
  assert.equal(cleanEvent.payload.recoveredTickets, 2)
  assert.equal(cleanEvent.payload.startupMs, 1234)
  assert.equal(cleanEvent.payload.notified, true)

  // 3) The same process never announces twice, even if startup() runs again.
  assert.equal(controller.announceRiaRestart({ recoveredTickets: 5, startupMs: 999 }), null)
  assert.equal(notices.length, 1, 'dedupe keeps the count at one')
  assert.equal(restartEvents().length, 1, 'dedupe keeps the event at one')

  // 4) Abnormal exit: the previous process never marked a clean stop.
  controller.bootAnnounced = false
  service.boot = {
    prev: { pid: 333333, startedAt: 1, cleanExit: false },
    current: { pid: 444444, startedAt: 2, cleanExit: false },
    classification: { kind: 'restart', reason: 'abnormal_exit' },
  }
  controller.announceRiaRestart({ recoveredTickets: 0, startupMs: 400 })
  assert.equal(notices.length, 2)
  assert.match(notices[1], /PID 333333 → 444444/)
  assert.match(notices[1], /异常退出/)
  assert.match(notices[1], /恢复工单 0 张/)
  // Several events can share one millisecond, so select by reason, not order.
  const abnormalEvent = restartEvents().find(item => item.payload && item.payload.reason === 'abnormal_exit')
  assert.ok(abnormalEvent, 'the abnormal-exit restart event is recorded')
  assert.equal(abnormalEvent.payload.prevPid, 333333)
  assert.equal(abnormalEvent.payload.newPid, 444444)

  // 5) Same-process re-init (pid equal) stays silent.
  controller.bootAnnounced = false
  service.boot = {
    prev: { pid: 444444, startedAt: 1, cleanExit: false },
    current: { pid: 444444, startedAt: 2, cleanExit: false },
    classification: { kind: 'same_process', reason: null },
  }
  assert.equal(controller.announceRiaRestart({}), null)
  assert.equal(notices.length, 2)

  // 6) A throwing notice channel must not break startup or write a false event.
  controller.bootAnnounced = false
  service.boot = {
    prev: { pid: 555555, startedAt: 1, cleanExit: true },
    current: { pid: 666666, startedAt: 2, cleanExit: false },
    classification: { kind: 'restart', reason: 'clean_restart' },
  }
  const eventsBefore = restartEvents().length
  controller.queueChatNotice = () => { throw new Error('chat unavailable') }
  assert.equal(controller.announceRiaRestart({ recoveredTickets: 1, startupMs: 50 }), null)
  assert.equal(restartEvents().length, eventsBefore, 'no event when the notice could not be queued')

  console.log('restart notice ok')
} finally {
  fixture.cleanup()
}
