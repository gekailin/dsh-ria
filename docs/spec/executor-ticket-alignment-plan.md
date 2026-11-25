# Executor & Ticket 设定对齐改造方案

本方案基于 [executor.md](executor.md) 与 [ticket.md](ticket.md)（及根目录 [DESIGN.md](../../DESIGN.md)），将当前 `exp` 分支代码与核心设定之间的全部偏差拆分为 **6 个可独立交付与验证的工作包（WP1–WP6）**。

> 实施总约束：遵守 [AGENTS.md](../../AGENTS.md)，**不得直接修改 `DESIGN.md`**；不新增定时轮询或看门狗；每个 WP 完成后跑全量 `npm test` 保持 100% 通过。

---

## WP1：双层串行锁 + 原生 `steer` 改造（消除竞态、简化下行通道）

**目标**：落实 [executor.md §2](executor.md) 与 [ticket.md §6](ticket.md)，用 `ticketLock → executorLock` 双层串行锁 + DSH 原生 `agent.steer()` 替代旧的 `executor_inbox` 三路投递状态机。

### 改动点
1. **新增双层串行锁工具**（`lib/core/controller.mjs` 或独立模块 `lib/core/locks.mjs`）：
   - `withTicketLock(ticketId, fn)`：串行保护 `plan / resume / stop` 等无 Executor 或跨异步状态变更入口。
   - `withExecutorLock(executorId, fn)`：串行保护同一 Executor 的 `dispatch / steer / settle / stop`。
   - 严格单向嵌套：`withTicketLock` 内可调用 `withExecutorLock`，反向禁止；`settle` 仅持 `withExecutorLock`。
2. **`turn/end` 同步入锁**（`lib/core/controller.mjs`）：
   - 在 `onSessionEvent` 收到 `turn/end`（及 `session/ended`、`session/disposed`）时，**同步**调用 `void this.withExecutorLock(id, () => this.settleTicketFromExecutorEvent(id, event))`，确保紧随其后的 `steer` 或新工单 `dispatch` 必排在结算之后。
3. **改造 `chatSteer` 直接走 DSH 原生 `steer`**（`lib/core/controller.mjs`）：
   - 进入 `withExecutorLock(executorId, ...)` 后复核 `ticket.status === 'working' && String(ticket.executor) === executorId`：
     - 若已结案或已切换，直接返回 `{ ok: false, code: 'ticket_closed' }`（不发脏消息、不重开旧单）。
     - 校验通过后调用 `this.injectUserMessage(executorId, message, 'user', 'ria_steer_' + randomUUID())`（底层走 `agent.steer`，保留 `{ kind: 'user', rpcId: 'ria_steer_...' }`；无 live agent 时降级 `promptSession(..., 'steer', rpcId)`）。
   - 记录 `steer.delivered` 路由事件；不再经由 `injectSteerAtPreStep` / `deliverManagerInboxIfIdle` / `retryManagerInboxAtTurnEnd` 三套投递路径。
4. **改造 `settleCompletedTurn` 的 inbox 暂缓检查**（`lib/core/controller.mjs`）：
   - 结算前通过 `resolveAgent(sessionId)` 读取 `agent.inbox.nextStep`（若 live agent 存在）：
     - 仅当存在 `msg.source?.kind === 'user' && String(msg.source?.rpcId || '').startsWith('ria_steer_')` 时，暂缓本次结算（返回 `{ ok: true, settled: false, reason: 'pending_steer' }`，保持 `working` 且不释放 Executor），等下一轮 `turn/end` 再结。
     - **显式忽略**用户直连消息（无 `ria_` 前缀）与直转消息（`ria_forward_`），确保协管会话在结算临界遇到用户插话时不阻塞原工单结算。
   - 同时修复旧 `settleDoneReport` 中“投递未读 steer 后未 `return` 仍直接结成 `done`”的 bug。
5. **统一 `rpcId` 子前缀 & 清理非 `user` 注入例外**：
   - `ria_chat_forward` 使用 `'ria_forward_' + randomUUID()`。
   - 核查 `applyExecutorSoftStop`（`controller.mjs:1491`）与 `direct-user-notice`（`controller.mjs:1423`）：若仍保留 `pre-step` 软停止/直连拦截，按约定明确其定位或统一 `rpcId: 'ria_...'`。
6. **更新工具描述与 Prompt**：
   - 更新 `lib/tools/registry.mjs` 中 `ria_chat_steer` 描述，反映原生 `steer` 与锁保护语义。

### 验收测试
- `steer` 在 `working` 时成功通过原生 `agent.steer` 投递且带 `source: { kind: 'user', rpcId: 'ria_steer_...' }`。
- `turn/end` 临界点：`steer` 在 `turn/end` 前写入 `agent.inbox.nextStep` → 首次 `turn/end` 暂缓结算，下一轮 `turn/end` 正常结案 `done`。
- `turn/end` 之后到达的 `steer` 排队拿锁后看到 `done` → 返回 `ticket_closed`，不向 Executor 发消息、不串台到后续工单 T2。
- 协管会话在 `turn/end` 临界收到用户直连消息 → 原工单正常结算 `done`，用户消息不被拦截且新 turn 按无工单协管处理。
- 并发 `resume` 同一张 `blocked` 工单 → `ticketLock` 串行化，不会派发两个 Executor。

---

## WP2：统一事件驱动结算 & 协管有/无工单双轨切分

**目标**：落实 [executor.md §1, §3, §5](executor.md) 与 [ticket.md §4, §5](ticket.md)，修复协管工单永远不结算、无 report 不兜底结算的问题，并消除 `noticeSignatures` 去重兜底。

### 改动点
1. **统一 `turn/end` 兜底结算逻辑**（`lib/core/controller.mjs`）：
   - `settleCompletedTurn()` 到达正常 `turn/end`（且无 pending approval、无 pending `ria_steer_`）：
     - 若存在终态 report（`done` / `blocked` / `failed`）→ 按该 report 结算。
     - **若无终态 report**（包括：直管未调 `ria_executor_report`、直管只调了 `progress` 但 turn 已正常结束、或协管无 report 工具）→ **不再卡在 `progress_report` 或 `blocked(no_report)`**，而是提取该 turn 的最后一条 `assistant/message` 文本，作为兜底结论写入工单报告并结算为 `done`（若该 turn 确实完全无任何 assistant 文本输出，再兜底 `blocked(waitingOn='executor', reason='empty_turn')`）。
   - 提取最终回复时按 `event.data.turn` 严格限定为当前结算 turn，避免临界串读下一 turn。
2. **切分协管会话的「有工单」与「无工单」事件入口**（`lib/core/controller.mjs`）：
   - 重构 `onSessionEvent`（当前 `1044–1079` 行的脆弱 `return true` 穿透逻辑）：
     - 先判断该 `sessionId` 当前是否绑定了 `working` 工单（`this.executorWorkingTicket(id)`）：
       - **有工单时**：统一走 Executor 生命周期通道（`turn/start`、`assistant/message` 仅记录最新 turn 文本/进展、`turn/end` 走统一 `settleTicketFromExecutorEvent`），**不走** `coManagement.onAssistant` 的 conversational relay，从而彻底避免同一回复同时触发 watch relay 与 ticket notice。
       - **无工单时**（用户直聊或直转）：走 `coManagement` 观察转发 + 触发 WP5 的自动打标。
     - 用户直连消息（`user/message` 且非 `ria_` 前缀）在协管会话下无论有无工单均正常记录并知悉，绝不拦截。
3. **移除因双轨撞车产生的 `noticeSignatures` 去重兜底**（`lib/core/controller.mjs`）：
   - 核对 `sendWatchRelay`（`3523–3574` 行）与 `notifyTicketStatus`：切干净入口后，有工单的协管不再进 `sendWatchRelay`，移除重复状态通知的抑制补丁。

### 验收测试
- 协管会话接工单执行完毕触发 `turn/end` → 自动以该 turn 最终回复写入工单报告并结算 `done`，只发一条工单状态通知（不发重复 watch relay）。
- 直管 Executor 漏调 `ria_executor_report(done)`（或仅调过 `progress`）后 `turn/end` → 自动以该 turn 最终回复兜底结算 `done`。
- 协管会话无工单（直转或用户直聊）→ 正常触发观察转发，不影响工单表。

---

## WP3：收紧未协管会话审批通知 & 清理定时提醒

**目标**：落实 [executor.md §3, §4, §7](executor.md)，杜绝未协管常规会话泄露通知，清理非事件驱动的定时提醒。

### 改动点
1. **收紧 `noticeApproval`**（`lib/core/controller.mjs:3153–3158`）：
   - 当会话既不是内部角色（`roleFor(sessionId)` 为空）又不在活跃协管中（`!this.coManagement.active(sessionId)`）时，**禁止调用 `notifySessionApproval`**；改为与 `noticeQuestion` 一致，记录 `notice.suppressed (reason: 'unwatched')` 后直接 `return await next()`。
2. **清理审批 10 分钟定时重发**（`lib/core/controller.mjs:3258–3270`）：
   - 移除 `sendApprovalReminder` 的 `setTimeout` 定时重发（符合「靠机制不靠看门狗」；首次审批请求已即时通知并持久化为 `blocked(waitingOn='approval')`）。
3. **核查协管会话 `approval/asked` 与 `approval/decided` 同步**：
   - 当协管会话正在跑工单时，`onApprovalAsked` / `onApprovalDecided`（`lib/core/approval-coordinator.mjs:48,120`）应同等对协管 Executor 生效（确认 `roleFor(coManagedSessionId)` 返回 `'executor'`），保证直管与协管在工单审批状态流转上完全一致。

### 验收测试
- 未协管常规会话触发 `approval/request` → Chat/Claw 不收到任何通知，路由事件记录 `notice.suppressed (unwatched)`。
- 已协管会话触发低风险/高风险 `approval/request` → 低风险自动放行并通知，高风险上报用户（有工单时工单转 `blocked(waitingOn='approval')`）。

---

## WP4：砍掉 `requireTagMatch` & 新建直管初始 `tags` 非空

**目标**：落实 [executor.md §6](executor.md) 与 [ticket.md §3](ticket.md)，彻底消除“无标签僵尸直管”。

### 改动点
1. **移除 `requireTagMatch` 硬过滤**：
   - `lib/core/executor-pool.mjs`：删除 `isExecutorEligible`（`74–76` 行）与 `isExecutorSelectable`（`196` 行）中的 `requireTagMatch` 拒选分支；保留 `scoreExecutor` 的软亲和打分。
   - `lib/prompts/advisor.mjs`、`lib/core/advisor.mjs`、`lib/tools/registry.mjs`、`lib/core/controller.mjs`、`lib/index.js`：从 Advisor schema/prompt 与路由上下文中移除 `requireTagMatch`（解析旧历史 JSON 时静默忽略即可，不报错）。
2. **新建常规直管 Executor 强制写入非空初始 `tags`**（`lib/core/controller.mjs:2365–2377`）：
   - 在 `ensureExecutor()` 创建常规 `work` 直管时，按优先级汇总初始标签：
     1. 触发工单的 `ticketTags`（`meta.routingTags` + `workOrder.routing.tags`）；
     2. 主关联主题的 `topic.tags`；
     3. 兜底：若上述全空，从 `projectId` / `basename(workspaceCwd)` / `'general'` 生成至少 1 个合法规范化标签（经 `normalizeTags`）。
   - 在 `createIdleExecutor` / `addExecutor` 时直接写入 `tags`（非空），不再留空数组。

### 验收测试
- 同项目有空闲 Executor 但标签无交集时，不再因 `requireTagMatch` 新建直管，直接按打分复用。
- 无空闲 Executor 时新建常规直管，其 `tags` 必非空（包含工单/主题标签，无标签时回退项目名/general）。

---

## WP5：统一 `autotags` 自动打标机制（工单完成 + 协管观察消息）

**目标**：落实 [executor.md §6](executor.md)：「工单完成后（取消不打标）与跟踪协管会话观察到消息时，统一走同一套自动打标机制；按 DSH turn 轮次衰减（阈值约 30 turns），判定时过滤、不删除历史记录。」

### 改动点
1. **抽取统一打标核心方法 `recordExecutorAutoTags(executorId, rawTags, { turn, at, ticketId, trigger })`**（`lib/core/controller.mjs`）：
   - 统一负责：规范化标签、过滤已存在于显式 `tags` 中的项、按 `max(previousTurn, currentTurn)` 写入 `autoTags[tag] = currentTurn`、更新 `lastTurn` / `lastUsedAt`、双写 `coManagement[].stats` 与 `executors[]`。
   - 若传入 `ticketId`，顺带做 `autoTaggedTicketIds` 幂等去重与 `recentTopics` 更新。
2. **两个触发入口共用该方法**：
   - **入口 A（工单 `done` 结算）**：`applyTicketCompletionToExecutor` 收集 `routingTags` + `topic.tags` 后直接调用 `recordExecutorAutoTags`（取消/失败/阻塞绝不调用）。
   - **入口 B（跟踪协管会话观察到消息）**：在无工单的协管会话 `turn/end`（或观察到 `user/message` / `assistant/message`）时，用轻量确定性规则从消息文本与项目已知标签词表（项目 `topics.tags` + 现有 `executors` 词表 + 路径/模块关键词）提取候选标签，传入同一个 `recordExecutorAutoTags(..., { turn, trigger: 'co-managed.observe' })`。
   - 保持取消协管时 `coManagement[].stats.autoTags` 完整保留，重新协管自动恢复。

### 验收测试
- 直管/协管工单 `done` 后均通过 `recordExecutorAutoTags` 写入 `autoTags`；`cancelled` / `failed` 不写入。
- 协管会话（`allowAutoDispatch=false` 跟踪模式）在用户直聊或直转完成一轮后，自动提取命中词表的标签并写入 `autoTags`（记录对应 DSH turn）。
- 取消协管再重新协管，`autoTags` 保持不丢失。

---

## WP6：清理历史别名与旧工具面（收尾）

**目标**：落实 [executor.md §1, §7](executor.md)，减少工具面噪音与命名分裂。

### 改动点
1. **移除废弃别名与旧工具**（需先检查全库测试引用）：
   - `lib/tools/tool-catalog.mjs`、`lib/tools/registry.mjs`、`lib/core/controller.mjs`：
     - 移除 `ria_chat_watch`（统一用 `ria_chat_co_manage`）；
     - 移除 `ria_chat_worker_config`、`ria_worker_report`、`worker_report` 等 `worker` 旧别名（统一 `executor` 命名）；
     - 移除 `ria_chat_executor_config` 中已弃用的 `model/provider/reasoningEffort` 透传参数（统一由 `ria_chat_session_config` 管理）。
2. **评估清理旧 `outboxTimer` 轮询**（`lib/index.js:6818`）：
   - 确认新控制面是否仍依赖 `outbox.json` 轮询；若仅渠道重发使用则明确限定为渠道发送队列，与工单状态机彻底解耦。

---

## 推荐执行顺序

1. **第一批（核心正确性，建议串行或先做）**：**WP2**（结算与协管双轨切分） → **WP1**（双层锁 + 原生 `steer`）
2. **第二批（边界与路由健康，可并行）**：**WP3**（收紧审批通知/去定时器） + **WP4**（砍 `requireTagMatch` + 直管初始 `tags`）
3. **第三批（能力完善与收尾）**：**WP5**（统一 `autotags` 观察打标） → **WP6**（清理废弃别名）

每个 WP 独立提交 commit，完成后运行 `npm test` 确认全部用例通过。
