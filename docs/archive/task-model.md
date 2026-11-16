# 任务模型设计（历史稿）：从用户消息到工单

> 状态：历史设计（2026-11-11）/ 部分实现：P0 已落地，P1 分叉方案未实现
> 现行文档见 [design-history.md](design-history.md) 第 4、10、12、20 节与 [tools.md](../tools.md)、[state-and-api.md](../state-and-api.md)。

## 背景与目标

- 基线问题：旧实现只有 5 个状态的 task，另有一套与 task 平行的顶层 `inFlight`（`{turnId, startedAt, lastUserMessage, lastPhase, recoveryCount}`）。“每条用户消息有归宿”只能靠模型自觉调 `ria_task`，而 prompt 不是保证：模型可能直接结束 turn、上下文压缩后忘掉未定性消息、工具调用失败后继续、用户中途中止、进程被 kill。
- 目标：把“用户消息”变成任务系统唯一入口（host 在 `agent/pre-step` 自动登记 intake），把“任务有归宿”变成 host 强制不变量（`agent/turn-stopping` + `RiaStore.transitionTask`），并把 `inFlight` 收编为未收敛任务的一种状态。
- 范围与约束：只做设计，不改 `lib/`、不改测试、不重启 dsh web；不含多 Ria 实例、跨机器同步、worker 内部实现、UI 视觉。

## 关键决策（含理由）

1. **每条真实用户消息都建 root task，含寒暄与提问**。寒暄在同 turn 内以 `done + resolution.kind='answered'` 收敛，不进活跃看板、不发卡片、不进微信，只留审计记录。理由：让“有归宿”成为可检查的事实，而不是把寒暄当工作。
2. **状态从 5 个扩到 8 个**：`intake / open / working / blocked / forked / done / failed / cancelled`；`answered / merged / control` 是 `done.resolution.kind`，不是状态。理由：寒暄、补充、控制指令都能落在终态 task 上，不必为它们造状态。
3. **分叉选方案 B（父 task 派生多个子 task）**，否决方案 A（一个 task 挂多个 assignment）。理由：A 破坏“一个 task 一个 executor”，需要第二套 assignment 状态机，部分失败无法用单一 status 表达，恢复要扫 assignments；B 复用现有 `toolRequest` 预检、`task.executor` 校验、worker-idle 按 working task 找 executor 的路径，恢复与上限都能按 task 计。
4. **所有状态变更只经 `transitionTask`**：同一次写盘里校验不变量、追加 feedback、触发卡片/微信。理由：杜绝“状态改了但反馈没写”。
5. **删除顶层 `inFlight`**：`turnId→origin.turn`、`lastUserMessage→origin.text`、`lastPhase→progress.lastPhase`、`recoveryCount→recovery.count`。理由：它没有 taskId、acceptance、executor、feedback，与 task 恢复是两套逻辑。
6. **职责切分**：prompt 负责语义质量（怎么拆、怎么并、怎么问），host hook 负责存在性（有没有 task、有没有归宿、有没有反馈）；捕获写盘失败不静默——记录 error、注入可见错误 notice、让当前 turn 失败，宁可让用户看到“未能登记这条消息”。

## 关键机制与数字

**捕获点（`agent/pre-step`，prepend，`dsh-agent-loop/lib/index.js:685`）**

- 必须等 `next()` 返回 `kind==='enter'` 后再捕获：被 `reject` 的消息没有进入模型，不能建“假 task”。
- 只认 `message.source.kind === 'user'` 且 `rpcId` 不以 `host_` 开头；`wx_` 开头的微信消息仍算用户消息、要建。
- 注入的 notice 用 `source.kind='ria-task-host'`（对照 `dsh-action-cards/lib/index.js:395-430` 的 `action-cards` 做法），下一次 pre-step 不会当成新消息，避免递归。
- 去重键：主 `(sessionId, message.id)`，辅 `(sessionId, turn, rpcId, contentHash)`；重投/重放返回已有 task 并标 `deduped=true`。
- 每条消息只建一个 root，后续合并/拆分由 `ria_resolve` 在 root 上决定；notice 只给 taskId、截断 120 字摘要、候选 task，不给全文。语义合并必须由 Ria 显式选择，host 只给候选：上一条 turn 结束时的 `blocked(waitingOn='user')` 且 24h 内优先，否则最近 5 个活跃 task 的 `taskId + goal`。

**“每条消息必须有归宿”的四层强制点**

| 层 | 位置 | 保证 |
|---|---|---|
| 1 捕获 | `agent/pre-step` + `RiaStore.captureIntake` | 模型看到消息前 root 已写盘 |
| 2 定性 | 新工具 `ria_resolve` + `RiaStore.resolveIntake` | 只有它能消费 intake，每个 root 只能定性一次 |
| 3 兜底 | `agent/turn-stopping` | 首次 `agent.steer` 提醒并列出 taskId，`nudgeCount` 限一次；第二次仍无则自动 blocked + 卡片，再允许关闭 turn |
| 4 异常收尾 | `session/event turn/end` | `aborted(user)` → 未定性 intake 转 cancelled；崩溃保留 intake 交 startup |

- `turn-stopping` 是 serial hook，payload 为 `{agent, turn, signal}`；`signal.aborted` 已置位时不再 steer，交给第 4 层。

**8 状态与关键不变量（`transitionTask` 校验）**

- `status` 必须在 8 个枚举内、`taskId` 唯一；`intake`、`forked` 的 `executor === null`，其余状态必须是 `'self'` 或一个顶层 session id。
- `blocked` 必须有非空 `blockedReason` 与 `waitingOn`；`done` 必须有 `resolution.summary`；`failed` 必须有 `failure.code + message`；`cancelled` 必须有 `resolution.reason`。
- 所有非终态必须有 `waitingOn`：`intake/open→ria`、`working→worker|ria`（worker 在跑为 worker，turn 已结束等 Ria 核对为 ria）、`blocked→user/approval/environment`、`forked→children`。
- `working` 必须有 `attempt.lastRequestId`；同一 requestId 不产生第二个 attempt（v1 迁移的 legacy task 例外：`attempt.lastRequestId=null`、`attempt.legacy=true`，仍作恢复候选）。
- 父子无环、`forkDepth ≤ 2`、每个父 2–8 个子 task；`dependsOn` 只允许同父兄弟，host 只校验无环，不自动调度。
- 终态写 `closedAt`；reopen 清 `closedAt/failure/resolution` 但保留 `history` 与旧 `attempts`。
- 每次变更 `revision += 1`；工具可带 `expectedRevision`，不匹配返回 `stale_revision`，不覆盖并发写。
- 只有 `transitionTask` 能改 status；`updateTask` 只能改 `goal/acceptance/executor/blockedReason/progress`。
- `blocked` 不是终态，终态是 `done/failed/cancelled`；reopen 必须由用户意图触发（Ria 不能“看起来还能救”就自行 reopen），父 task 聚合优先级 `blocked > failed > cancelled > done`，避免把“等回答”误报为失败，子任务全 done 才父 done。

**失败矩阵与反馈契约**

- 18 个场景 / 17 个 code：`not_top_level`、`task_executor_mismatch` 保持 open（`waitingOn=ria`，发低干扰 `dispatch_rejected` 卡）；`session_missing`、`session_archived`、`workspace_missing`、`needs_input`、`worker_refused`、`worker_cancelled`、`recovery_exhausted`、`delivery_failed` 进 blocked（`waitingOn=user`）；`approval_pending→waitingOn=approval`；`environment_unavailable→waitingOn=environment`；`worker_error`、`worker_truncated` 进 failed；`child_failed`、`child_blocked` 用于父聚合；`intake_unresolved` 用于兜底。
- 分界：能由 Ria 修正的不让用户替它修 bug；需要用户/环境的进 blocked 且不自动改派；worker 真实报错进 failed 且不静默重试；用户点“停止”只中止当轮，进 `blocked(waitingOn=user)`、写“已停止，等你下一步”，只有明确“取消这个任务”才进 cancelled。
- feedback 是不可变记录，`body ≤ 500` 字符（`FEEDBACK_BODY_LIMIT`），同一 `(taskId, kind, code, workerTurn)` 5 秒内去重（`FEEDBACK_DEDUPE_MS=5000`），由 `transitionTask` 在同一次 `save()` 追加。
- 微信只镜像 `dispatched / blocked / failed / done / cancelled / forked / recovery_exhausted`；`captured / progress / updated / answered` 不镜像。卡片/微信是副作用，失败不回滚状态，但要在 `channels` 记 `card:false/wechat:false`。
- 不做定时轮询播报：worker 每轮结束即天然 tick；working 超 30 分钟无事件置 `stale=true` 仅标注，不自动发卡；`settings.progressCards` 默认 false，P2 才允许每 task 最多 3 张/90 分钟。

**重启恢复**

- 只扫 `intake/open/working/forked`；forked 父只递归子 task，本身不作恢复单元；`blocked/failed/done/cancelled` 不自动恢复；多个候选合并成 1 条 `host_` prompt，超过 10 个只详列前 10 条。
- `recovery.count >= 3` → `blocked + failure.code='recovery_exhausted'` + 一次性卡片，不再进恢复 prompt；成功派发、用户补充/回答、用户 reopen 归零，worker 普通 turn 完成不归零（否则长任务永不触发上限）。

**schema v2 与迁移**

- `version: 1 → 2`；删顶层 `inFlight`；`tasks[]` 增 `origin`（必填）、`waitingOn`、`parentTaskId/rootTaskId/forkDepth/childTaskIds/dependsOn/fork`、`attempt`、`lastWorkerTurn`、`progress`、`recovery{count,lastAt}`、`failure/resolution`、`revision`。
- 新增 `taskFeedback` 取代 `dispatchNotes` 写入（上限 500 条，`dispatchNotes` 只读兼容一版）；`settings.progressCards=false`；`deliveries` 增 `attempts/lastError`。
- 迁移：先备份 `ria.json.v1.bak`、`normalizeTask` 保留 `...old` 不丢未知字段、幂等（读到 v2 不再迁移）、`version > 2` 只读加载并 warn 不降级写回；写盘失败保留旧文件，内存用迁移后结构运行。
- 旧 `inFlight` 迁成 `open`/`blocked`（`executor='self'`）而非 `intake`：它对应的是一条已被 Ria 接住并开始执行的消息，不是新捕获输入。

**merge（M2，task 间合并）**

- merge 是收敛不是删除：source 以 `done + resolution.kind='merged'` 结束，target 接管历史、子任务与未投递消息，所有 ID 永久保留。
- 执行顺序第 7 步必须走 `transitionTask`，不能 `updateTask({status:'done'})`，否则 source 的 feedback、`closedAt`、归档都不会发生；最后只 `save()` 一次。
- 8 个错误码先校验后写入、失败零写入：`merge_self / task_missing / source_closed / target_closed / merge_cycle / merge_root_mismatch / target_busy / merge_irreversible`。
- 保留 target 的 executor、goal、acceptance、recoveryCount；source 的 attempts 只留一条摘要进 target（避免重复计数）；已 merged 的 source 不可 reopen。

**终态归档（M2）**

- `ria.json` 只留非终态 + “近 24h 或前 50 条终态”（并集），单次裁剪最多 200 条，剩下的下次 startup 继续。
- 布局：`tickets.log.jsonl` 当月热段 + `tickets-YYYY-MM.jsonl` 按月（UTC）滚动、保留 12 个月；先 append 并 flush 成功，才从 `ria.json` 删除，失败保留并 warn；允许重复行，读取端按 `(taskId, closedAt)` 去重。
- 归档记录 `schema:1`，含完整 `task` 快照供 reopen；列表返回 `goalPreview`（前 200 字符）。
- 默认列表永不返回归档；要历史须 `scope=history`（默认 `limit=50`，可带 `month`）或指定 `taskId`。

## 实现状态

- P0 已实施并被后续阶段继承：`agent/pre-step` 捕获（`lib/index.js:2879`）、`agent/turn-stopping` 兜底（`lib/index.js:2880`）、`captureIntake`（`lib/index.js:1181`）、`ria_resolve` 与 `intake_requires_resolve` 错误（`lib/index.js:3514`）、8 状态与不变量（`lib/tickets.mjs:8-10`）、merge（`lib/index.js:1409-1476`）、归档常量 24h/50/200（`lib/index.js:48-50`）、恢复上限 3（`lib/tickets.mjs:14`）。
- task → ticket 改名已完成：工具为 `ria_ticket`、参数 `ticketId`、状态入口 `RiaStore.transitionTicket`、`tasks[]→tickets[]`、`childTaskIds→childTicketIds`；顶层 `inFlight` 已删除，legacy inFlight 由迁移吸收（`lib/tickets.mjs:366`）。本稿正文仍保留实施前的 `task` 术语、示意代码与旧行号，不是现行 API 契约。
- schema 已越过 v2：v2 本稿状态机 → v3 排队/dependsOn → v4 checklist → v5 topics，均带 `.vN.bak` 备份。

## 仍未实现 / 风险

- **P1 分叉未实施**：`ria_resolve kind=split` 直接返回 `{ok:false, code:'not_supported', message:'split/fork is P1 and is not supported yet'}`（`lib/index.js:1371-1372`）；但工具 schema 仍把 `split` 列在 enum 里（`lib/index.js:3155`），prompt 规则仍写“六选一”（`lib/index.js:2942`），声明与行为不一致，调用方会踩空。
- `forked` 的数据层已备好（状态枚举、2–8 子 task、`forkDepth ≤ 2`、`waitingOn='children'` 校验），缺的是创建路径、父子聚合、级联取消、树形 `ria_status` 与唯一父卡片。
- 属 P2 未做：progress 卡片开关与限流、客户端树形面板与 feedback 流、指标（intake→终态时长、blocked 率、recovery 次数、无人认领 task 数）。
- `ria_request` 的 `taskId` 改为必填是有意的破坏性变更；若不保留 `task_required` 说明，旧“无 task 快速派发”调用会直接失败。
- 多 Ria 实例/多进程并发未解决：store 仍是单进程内存 + 原子写，未来需要文件锁或单写者网关。
- `turn-stopping` steer 的递归风险只靠三件事兜住：`nudgeCount` 限一次、steer 消息的 source 不能是 `user`、`signal.aborted` 时不 steer。
- 父聚合优先级 `blocked > failed > cancelled > done` 是产品取舍；若改成纯按失败聚合，必须二选一并同步改父卡片文案。
- 归档与 merge 的交叉：已 merged 的 source 立即归档且 `reopen` 返回 `merge_irreversible`，只能 reopen target 或新建；target 失败时用户只能从 `resolution.mergedInto` 反查。

## 现行文档

- [design-history.md](design-history.md)：第 4 节 Ticket、第 10 节启动恢复、第 12 节状态文件、第 20 节实现状态。
- `docs/tools.md`（15 个 `ria_*` 工具参考）、`docs/state-and-api.md`（状态目录与 HTTP API）、`docs/operations.md`（运行与工单生命周期）、`docs/limitations.md`（已知限制）、`docs/testing.md`（测试套件覆盖）。
