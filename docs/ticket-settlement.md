# Ticket Settlement

本文件定义 dsh-ria 的票据结算规则。核心约定只有一句：

> **report 是记录，不是结算；结算只由执行器事件驱动。**

直管（managed）与协管（co-managed）Executor 使用同一条结算路径。两者唯一的差异是：协管会话没有 `ria_executor_report` 工具，它的 assistant 回复会被记录成 report；这只是“是否出现 report”的现象差异，不是结算策略差异。

## 1. 结算规则表

结算入口：`settleTicketFromExecutorEvent(sessionId, event)`。
事件源是 DSH 的 executor 生命周期事件，不是 report 工具返回值。

| 事件 | 目标状态 | waitingOn | 附加字段 / 说明 |
|---|---|---|---|
| `turn/end` + `completed`，当前 executing，无 pending 提问、无待审批、无错误，最新 report = done | `done` | `none` | 使用该 report 的 summary/evidence；写 resolution；释放 executor |
| `turn/end` + `completed`，同上，但没有 report | `done` | `none` | 写 `no_report: true`；resolution 使用 turn/end 的自动摘要 |
| `turn/end` + `completed`，最新 report = progress | 保持 `working` | `executor` | progress 表示还有后续 turn；不提前结算 |
| `turn/end` + `completed`，最新 report = blocked | `blocked` | `user` | 使用 report 的 question/summary；写 attention |
| `turn/end` + `completed`，最新 report = failed | `failed` | `none` | failure 来自 report |
| 提问（`user-questions/request`） | `blocked` | `user` | attention.kind=question；保留问题原文 |
| 审批 `approval/asked` | `blocked` | `approval` | 沿用风险/审批审计；attention.kind=approval |
| 审批 `approval/decided` + allowed | `working` | `executor` | blocked → open → working；无直接边 |
| 审批 rejected/cancelled | 保持 `blocked` | `approval` | 只更新 failure/attention，不擅自 done/failed |
| `turn/end` + `error` | `failed` | `none` | 原始错误文本原样写入 failure.message；413 不截断、不改写 |
| `turn/end` + `aborted(reason.kind=user)` | `blocked` | `user` | 人类中止；不得判 failed/done |
| `turn/end` + 其他异常（max-tokens/unknown） | `blocked` | `environment` | 保留原始 kind；等待环境恢复 |
| `session/ended` / `session/disposed` / `session/end-seed` | `blocked` | `environment` | failure.code=session_ended |
| startup 发现 `working` | `blocked` | `environment` | reason=`interrupted`；不自动续跑 |

终态（done/failed/cancelled）不可改：结算器收到任何后续事件都直接忽略。

## 2. report 降级为记录

`ria_executor_report` 的旧行为是“report(done|blocked|failed) 立即 transitionTicket”。新行为是：

1. 校验 ticket / executor / summary / evidence；
2. 追加 report 记录（`state.addReport`）；
3. 发 `executor.report.recorded` 审计事件；
4. 返回 `{ ok: true, ticketId, status, report, recorded: true, settlementDeferred: true }`；
5. **不调用 `transitionTicket`，不释放 executor，不 supersede 审批，不写 canonical**。

真正改变票据状态的是之后到达的 executor 事件：

- 最终 `turn/end` 读取最新 report，决定 done/blocked/failed 或 no_report；
- 错误/中止/提问/审批事件直接按规则结算；
- report 只作为证据与 `no_report` 判定的输入。

解耦点：

| 位置 | 旧行为 | 新行为 |
|---|---|---|
| `executorReport` | 校验后按 status 直接 transition | 只写 report + 审计事件，返回 deferred |
| `finalizeSavedDone` | 重新调用 report(done) 驱动 done | 用 `turn/end` 合成事件调用结算器 |
| `trackApprovalTicket` | 直接 onApprovalAsked/Decided | 先经结算器，再委托同一审批实现 |
| co-managed session end | 专用 blockCoManagedSessionEnd | 统一 `session/ended` 结算分支 |
| `onExecutorTurnFailed` | error/abort 都 blocked(environment) | error→failed(raw)，human abort→blocked(user) |

## 3. managed / co-managed 统一

- 两者都通过 `settleTicketFromExecutorEvent` 结算。
- 代码中不再存在 `kind === 'co-managed'` 的结算分支；`kind` 只用于展示、归档、选人。
- 协管的 assistant 回复被记录为 progress report；这是 report 出现方式不同，不是策略不同。
- 直管 report 和协管 assistant report 都只是证据；最终状态都等 executor 事件。
- 唯一现象差异：直管通常有显式 `ria_executor_report(done|blocked)`，协管通常只有 assistant 文本；结算器不区分来源。

## 4. 多轮与终态

一张票可以跨多个 turn（steer / queue / 重启续跑）。规则：

- 只有“本次派发终结”的事件才结算；
- 最新 report = `progress` 时，`turn/end` 保持 working，等待后续 turn；
- 最新 report = `done|blocked|failed` 时，`turn/end` 结算；
- 没有 report 的单 turn 结束，结算为 done 并记 `no_report: true`；
- 已终态的票收到后续事件一律忽略（终态不可改）；
- 重复的 `turn/end` 不会二次通知、不会二次迁移。

`agent/turn-stopping` 与 inbox 重读只是 DSH 内部决定“是否还有下一步”的机制；dsh-ria 的票据结算不依赖它，仍以最终 executor 事件为准。

## 5. 重启对账

startup 时：

- 所有 `working` 票据 → `blocked(waitingOn=environment)`；
- `blockedReason` 以 `interrupted:` 开头；
- ticket meta 写 `reason: 'interrupted'`；
- 释放 executor，不自动续跑；
- 等下一次 executor 事件或人工 `ria_chat_resume`。

## 6. 代码位置

- 结算器：`lib/core/controller.mjs` 的 `settleTicketFromExecutorEvent`
- report 记录：`lib/core/controller.mjs` 的 `executorReport`
- 审批分发：`lib/core/approval-coordinator.mjs` 的 `trackApprovalTicket`
- 提问：`lib/core/controller.mjs` 的 `noticeQuestion`
- startup：`lib/core/controller.mjs` 的 `startup`
