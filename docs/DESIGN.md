# dsh-ria 设计方案

> 本文是历史设计记录与实现细节；顶层地图见 [docs/architecture.md](architecture.md)，核心设计见根 [DESIGN.md](../DESIGN.md)。
> 状态：v0.30（2026-11-12）
> 目标目录：/home/gkl/Desktop/vibe_proj/dsh-ria
> Ria 固定用 PTC preset（agentPreset=ptc）启动，模型只直接看到 run_code + SDK。本文是设计说明；实现状态见第 20 节。

## 1. 定义

Ria 是全局唯一的普通顶层 DSH Session。

- 使用 PTC preset（agentPreset=ptc），拥有完整工具集。
- 模型只直接看到 run_code 和生成的 SDK；12 个 ria_* 工具通过 SDK 在 run_code 内调用。
- 在它的 Agent ctx 上额外注入管理者提示词和 12 个 ria_* 工具。
- 不是 subagent，不是 Agent Team Lead。
- 默认不替用户干活：把需求整理成 ticket，转交给 worker；用户明确要求时，也可以自己完成具体任务，不限于总结。
- 用户可以像普通会话一样打开、对话、看历史。

### 名字

<img src="ria-avatar.png" width="120" align="right" alt="阿汐的头像">

**阿汐**，英文 **Ria**（西班牙语 *ría*，潮汐河口）。潮水有去有回；她做的事也一样：把事送出海，再把结果带回来。

> 潮起潮落，事事有着落。
> *Tide may roam — every wave comes home.*

文档和消息里，🌊 是她的签名，也是微信出站消息的标记；日志、状态文件和代码里不用 emoji。

### PTC 启动

- ensure 创建 Ria 时固定传 agentPreset: 'ptc'。
- PTC preset 需要 DSH 的 ptc runtime 和 tool-executor-ptc；缺失时 ensure 明确失败，不静默退回 standard。
- 已有非 PTC 的 Ria 不自动改 preset；提示用户重建或迁移，避免 SDK/工具状态不一致。
- 12 个 ria_* 工具必须在 run_code SDK 生成前注册；否则模型看不到它们。
- 提示词可以写“用 run_code 调用工具”，但真正的调用规则由 PTC executor 约束。

## 2. 边界

不做：

- attach/detach 和 managed 会话列表。
- needs_input/failed 的独立事件级唤醒；只做 worker idle 通知，不做审批/输入等待的自动提醒。
- Host 强制 brief / 澄清门禁。
- 多实例锁、409 防双开。
- lesson 目录、FTS5、向量检索。
- 专用 worker Preset，或修改 worker 的 tools/skills/MCP；只追加一个通用、可关闭的 system prompt section。

保留：

- 全局单例、按需 status、官方 schedule、启动恢复。
- 微信进程内接入。
- memory.md。

## 3. 架构

~~~text
用户 / 微信
   |
   v
Ria（ptc preset + prompt/tools；run_code + SDK）
   |
   v
RiaService
  |-- RiaStore（ria.json）
  |-- MemoryFile（memory.md）
  |-- RequestGateway（普通消息 + 幂等）
  |-- ApprovalObserver（approval/request 只读观察）
  |-- WorkerIdleWatcher（agent/status 只读观察，worker idle 通知）
  |-- DispatchGuard（agent 作用域 system prompt section，可开关）
  |-- TicketRecovery（启动时继续未收敛 ticket）
  |-- WechatService（进程内）
  |-- RiaHttpApi（ensure / 微信控制 / 暂停推送）
  |
  +--> sessionController.state/events（只读）
  +--> sessionController.prompt（user-rpc）
  +--> agent.ctx.systemPrompt.section / ctx.agents.list()（通用防误发提示）
  +--> workspaceRegistry.create/attach（Ria 专用 Workspace，UI 输入必需）
  |
  v
普通顶层 Worker Sessions（Preset/tools 不变）
~~~

没有 worker 进度轮询，没有独立 bridge 进程；副作用 outbox 有 30 秒投递 tick；只有两个只读业务事件观察器：approval/request 记录后立即 next()，agent/status 在 worker idle 时通知 Ria。DispatchGuard 另外监听 agent/created 与 agent/disposed，用于安装和清理 system prompt section。

## 4. Ticket

ticket 是 Ria 的管理单位；一个 ticket 只对应一个 executor。完整设计见 `task-model-design.md`。

- ticket 之间的排队 / 依赖机制见 `ticket-queue-design.md`（P0 已实现）。

~~~json
{
  "ticketId": "ticket_...",
  "status": "open",
  "goal": "修完 3 个失败测试，不改 public API",
  "acceptance": "回归全绿",
  "executor": "s_abc",
  "waitingOn": "ria",
  "dependsOn": ["ticket_upstream"],
  "readyAt": null,
  "readyNotifiedAt": null,
  "dependencyAlerts": [],
  "origin": { "kind": "user_message", "text": "…", "at": 0 },
  "parentTicketId": null,
  "rootTicketId": "ticket_...",
  "forkDepth": 0,
  "childTicketIds": [],
  "attempt": { "count": 0, "lastRequestId": null, "legacy": false },
  "attempts": [],
  "recovery": { "count": 0 },
  "blockedReason": "",
  "attention": null,
  "failure": null,
  "resolution": null,
  "history": [],
  "revision": 1,
  "createdAt": 0,
  "updatedAt": 0,
  "closedAt": null
}
~~~

- 8 个状态：`intake`、`open`、`working`、`blocked`、`forked`、`done`、`failed`、`cancelled`；终态是 `done`、`failed`、`cancelled`。
- `answered`、`merged`、`control` 是 `done.resolution.kind`，不是独立状态。
- `executor`：`self` 或一个顶层 worker sessionId；`intake` 与 `forked` 容器为 null。
- `waitingOn`：`ria`、`dependency`、`worker`、`user`、`approval`、`environment`、`children`、`none`；由状态决定，阻塞类必须有人可等。`dependency` 只出现在 `open`。
- 只有 `RiaStore.transitionTicket` 能改 status。它校验扩展后的转移表与 22 条不变量；非法转移返回 `invalid_transition`，`expectedRevision` 不匹配返回 `stale_revision`，都不静默改写。依赖写入失败返回 `dependency_invalid/duplicate/limit/self/missing/intake/cycle`，整次写入不生效。
- 每次变更 `revision+1`；终态写 `closedAt`；reopen 清空 `closedAt/failure/resolution` 并保留 history。
- `blocked + waitingOn=user` 可以带 `attention`：`{ kind: question|approval|decision, question, options?, askedAt, askedBy, ref? }`；question 为空时归一化为 null，离开 blocked 或关闭/reopen 时清空。只有老 `blockedReason` 的工单仍可读，`ria_status.attentionOverview` 用 `legacy=true` 标出。`attention` 是 Ria 请用户拍板的事，与 worker 审批（`ria_approval`）分开。
- `blocked` 必须有非空 `blockedReason` 且 `waitingOn` 是 user/approval/environment；`done` 必须有 `resolution.summary`；`failed` 必须有 `failure.code+message`；`cancelled` 必须有 `resolution.reason`。
- P1 分叉设计（当前未实现，split 返回 not_supported）：用父 ticket + 子 ticket：父 `status=forked`、`executor=null`，只做容器；子 ticket 各自一个 executor、独立派发/失败/恢复；全部子收敛后父按 blocked > failed > cancelled > done 聚合。`forkDepth` 最大 2，每个父 2–8 个子。
- 合并（`mergeTicket`）：source 的 history/attempts 摘要与子 ticket、deliveries 重挂到 target；依赖边先转移：其他工单指向 source 的边改为 target，source 的依赖并入尚未开跑的 target；source 以 `done + resolution.kind=merged` 收敛且不可 reopen；merged done 不算依赖完成，下游改为等 target。target 保留自己的 executor/goal/acceptance。错误码含 merge_self、ticket_missing、source_closed、target_closed、merge_cycle、merge_root_mismatch、target_busy、merge_irreversible。
- 用户消息 → intake 的四个强制点：
  1. `agent/pre-step`：只捕获 `source.kind==='user'` 且非 host_ 的消息，建 root intake，并注入 `source.kind='ria-task-host'` 的 `[Task intake]` notice（不是 user，防递归）。
  2. `ria_resolve`：Ria 逐条定性 answered/work/merge/control/blocked（split 属于 P1，当前返回 not_supported）；每个 intake 只能定性一次，`ria_ticket` 不得直接改 intake。
  3. `agent/turn-stopping`：仍有未定性 intake 时先 `agent.steer` 提醒一次；第二次仍未给归宿就自动 blocked，并产生 `intake_unresolved` 卡片。
  4. `turn/end`：`aborted(user)` 把未定性 intake 收敛为 cancelled；`error` 落 blocked；其余异常保留 intake，交给重启恢复。
- 广播给多个 worker：建多个 ticket（或一个 forked 父加子 ticket），不要一个 ticket 多 executor。
- 不保存 title、kind、source、lastRelayId、lastRecoveryAt。

### 4.1 归档与恢复

- 热文件 `ria.json` 保留所有非终态，加上最近 24h 关闭或按 closedAt 倒序最新 50 条终态；超窗写 `stateDir/tickets.log.jsonl`，同时按月写 `tickets-YYYY-MM.jsonl`（保留 12 个月）。新写入只用新名；启动时一次性把旧 `tasks*` 文件 rename 到新名（幂等，目标存在则跳过，失败只 log）。读取端同时兼容新旧名，按 `ticketId + closedAt` 去重，reopen 也扫两边。写成功后才从内存删除。
- `ria_status scope=history` / `ticketId` 可查归档；reopen 时先从日志捞回热存储，再走 T27。
- 重启恢复单位是 ticket：`intake`、`open`、`working`；`open + waitingOn=dependency` 不是恢复单位，`open` 且已有 `readyAt` 的依赖工单交给 queue wake，不重复列进恢复 prompt；`forked` 父只递归子 ticket；blocked/failed/done/cancelled 不自动恢复。每个 ticket 连续恢复最多 3 次，超过则 blocked + `failure.code=recovery_exhausted` + 卡片，不再发 prompt。
- 候选合并成一条恢复 prompt，逐条给 ticketId、status、executor、goal、acceptance、原消息、开始时间、最近动作和 recovery=n/3；排队中的工单只给一行汇总（排队中/已就绪/告警/无效计数），不逐条展开。

### 4.2 排队与依赖

- 依赖只表达先后，不新增 `queued` 状态：有未完成依赖的工单保持 `open + waitingOn=dependency`，不能派发；依赖全部 `done` 后转 `open + waitingOn=ria`，写 `readyAt`，并产生一次 queue wake。
- 依赖可跨 root、可指向归档的已完成工单；最多 8 个，不能自指、重复、指向 intake 或成环。热存储与归档日志共同解析，缺失视为 `dependency_missing`。
- 上游 `failed/cancelled` 时不自动跳过或改写需求：下游保持 `open/dependency`，写 `dependencyAlerts`，发 `[Queue blocked]` 让 Ria 报告用户；上游 `blocked` 只是继续等，不告警。
- `queueToken = ticketId:readyAt:revision` 不入库，只在就绪后提供；`ria_request` 必须带当前 token，工单已 working、退回等待或 revision 变化都返回 `ticket_not_ready`，保证同一次就绪最多派发一次。
- 唤醒以 outbox 为主：`queue_wake` / `queue_blocked` 在 Ria 没有活跃 turn 时由 `sessionController.prompt` 叫醒，turn/end 与 startup 补泵；不依赖 worker idle。
- 级联取消（`ria_ticket status=cancelled, cascade=downstream`）只取消排队/阻塞/intake 下游；working 下游不打断，作为 deferred 返回并报告用户。
- 忙碌 worker 禁止排队：`ria_request` 默认 mode=queue 时，只要目标有运行中的 turn 或非空 pending 队列就返回 `worker_busy`；steer 只允许做信息同步，不能下发新任务。

## 5. 工具

| 工具 | 作用 | 参数 |
|---|---|---|
| ria_ticket | 创建/更新/关闭/合并 ticket；dependsOn 表达先后，checklist 记录步骤，cascade=downstream 级联取消 | ticketId?, goal, acceptance?, executor, status?, dependsOn?, checklist?, replaceAll?, drop?, check?{index,done}, cascade?, action=merge + sourceTicketId/targetTicketId/note |
| ria_status | 查 ticket、历史归档、单条 ticket、可用顶层会话，或列近期 worker；sessions/recent 项带当前 provider/model/reasoningEffort | scope: tickets/sessions/recent/history, sessionId?, ticketId?, limit? |
| ria_spawn | 在已存在的绝对目录中新建顶层 worker 会话；可先解析并设置模型，再创建会话；title 失败只返回 titleError | cwd, agentPreset?, title?, model?, provider?, reasoningEffort? |
| ria_model | 改一个已存在会话（worker 或 Ria 自己）的模型；只改选择，不发消息、不建 ticket | sessionId, model, provider?, reasoningEffort? |
| ria_title | 改一个已存在顶层会话（含 Ria 自己，不含 subagent）的会话名；只改名，不发消息、不建 ticket、不唤醒 worker | sessionId, title |
| ria_resolve | 给 intake 定性 answered/work/merge/control/blocked；split 属于 P1，当前返回 not_supported；work 可带 dependsOn | ticketId, kind, summary?, goal?, acceptance?, executor?, dependsOn?, start?, targetTicketId?, action?, reason?, blockedReason?, waitingOn?, attention?, expectedRevision? |
| ria_request | 以普通用户消息发送内容；attachments 为图片绝对路径，投递前检查文件、宿主限制、目标模型与 worker 忙碌状态；依赖工单需当前 queueToken | targetSessionIds, message, content?, attachments?, ticketId, note, mode?, queueToken? |
| ria_read | 读会话最近消息；返回值带 queue，与 ria_queue list 同一份 pending 视图，冷会话为 null | sessionId, limit? |
| ria_queue | 列出或撤回顶层 worker 尚未执行的 pending 消息；只删 pending，不 cancel turn、不改 ticket、不影响 recentWorkers | action: list/remove, sessionId, itemId?, rpcId? |
| ria_approval | 列出等待审批的 worker | action: list |
| ria_grant | 临时调整 worker 的 sandbox/审批策略，并记录原值 | action: set/list/reset, sessionId?, ticketId?, sandboxMode?, approvalPolicy?, ttlSeconds?, reason?, grantId?, userConfirmed? |
| ria_memory | 读写 memory.md | action: read/remember/forget, text?, key? |

共同规则：

- 只在 Ria Agent ctx 注册。
- PTC 下不直接调用工具；模型写 run_code，通过 SDK 调用 tools.ria_*。
- 工具必须在 run_code SDK 生成前完成注册；Phase 0 验证。
- 不伪造用户消息之外的身份，不改 worker 的 preset/tools；只追加一个可关闭的通用 system prompt section。
- ticketId 是 ria_request 的必填关联；ticket 必须存在、未关闭且 executor 匹配目标。
- ria_ticket 的 status 更新也走 transitionTicket；非法转移返回错误而不是直接写值。
- broadcast 或 steer 前先向用户确认。

### Worker 模型

模型选择由 DSH 的 `sessionController.selectModel` 执行；Host 只做解析和预检。

- 模型从 `ctx.get('llm').listProviders()` + `listModels(provider)` 的注册表解析；同时给 provider 和 model 时精确匹配。只给 model 时必须在所有 provider 中唯一，否则返回 `model_not_found` 并列出候选/歧义，不猜。
- `ria_spawn` 在 create 之前解析模型，未知模型不会留下半配置会话；解析通过后先 create、再 title、最后 selectModel。selectModel 失败时返回 `ok:false`、`code=model_not_found` 和已创建的 sessionId，说明会话仍用默认模型，可用 `ria_model` 重试。
- `ria_model` 复用 ria_request 的预检（存在、顶层、非归档、cwd 可用），额外允许 Ria 自己；subagent 会话仍拒绝。成功返回 `{selected, previous?}`，不写卡片、不 concludeTurn。
- `ria_status` 的 sessions/recent 从会话 summary 的 `projections.values.modelSelection.next || lastUsed` 读取模型；拿不到字段就省略，保证输出是 lossless JSON。

### 近期 worker

“近期用过”只按 Host 成功接受过的 ria_request 计算；只建/改 ticket 不算。用户手工会话不计入。

- 窗口 7 天，最多返回 10 个，按 lastUsedAt 倒序；ria.json 保留 30 天后清理。
- scope=recent 返回 sessionId、title、cwd、lastUsedAt、lastTicketGoal、lastTicketStatus，以及 windowDays=7、limit=10、pendingDeliveries。
- scope=sessions 也带 title、lastUsedAt；title 来自 DSH 的 title projection，缺失时省略该字段。
- 用户没指定 worker 时，Ria 只能从 scope=recent 里选；不得遍历全部会话，不得凭空挑一个没用过的。
- scope=recent 为空、没有明显合适或 Ria 判断不清时，先问用户用哪个会话；不回退到任意或新会话。
- 用户明确给出 sessionId 时可直接用，必要时用 scope=sessions 校验是否为顶层。
- 所有可选字段条件写入，保证 PTC 输出是 lossless JSON。
- 选择规则是 manager prompt 约束，不是 Host 强制；Host 只负责记录和返回候选。

### 审批可见性

- 根 ctx 监听 `approval/request`，只记录 executor 有 open/working ticket 的 worker；Ria 自身、subagent、无活跃 ticket 的会话不记。
- 记录 approvalId、workerSessionId、ticketId、toolName、callId、reason、createdAt、expiresAt、AbortSignal；随即 `next()`，不接管、不代批。
- 捕获时把 active ticket 从 open/working 迁到 `blocked + waitingOn=approval`，写 `attention={kind:'approval', question, askedBy:'worker', ref:approvalId}`；`blockedReason` 为同一句中文问题。
- 通过 outbox 排 `approval_note` 卡片与 `wechat_approval_note` 微信提醒，dedupeKey 都是 approvalId；卡片等 Ria 活跃 turn，微信按现有队列/暂停规则发送。
- `ria_approval` 返回 pending 列表，每项带 ticketId、expiresAt 与 expiresInMs；无参数时需要 action=list。
- 清理：审批结束或 next() 抛错时 finally 清除；AbortSignal abort、15 分钟 TTL、插件 shutdown 都清除。清除时 ticket 走 blocked -> open -> working（waitingOn=worker）并清 attention；同一 ticket 的多个 pending 等最后一个结束。
- 审批队列只在内存；startup 把 blocked+approval 且没有对应 pending 的 ticket 恢复为 working，避免重启后永久 blocked。
- 该观察器不改变审批结果；没有 UI answerer 时仍由 DSH 返回 unavailable。
- 不自动批准、不替用户决策；用户必须打开对应 worker 会话批准/拒绝。

### 临时 worker 权限（审批阶段二）

- 只在用户明确要求时调用 `ria_grant`；`set` 必须带 `userConfirmed=true`。Ria 不得因为 ticket blocked、审批卡住或自己的判断自动提权。
- `set` 一次只改一个顶层 worker，至少指定 `sandboxMode` 或 `approvalPolicy`，可关联一个未关闭且 executor 匹配的 ticket。一个 worker 同时只能有一个有效 grant。
- 修改前记录 effective sandbox mode、sandbox override、effective approval policy、approval override；sandbox 通过 `session.append('sandbox/mode')` 写入，approval 通过 `ctx.approval.setPolicy(agent, policy)` 写入。
- `approvalPolicy=never` 表示需要审批的动作会被拒绝，不是自动允许；不要把它当作“放开权限”。
- 默认 TTL 30 分钟，允许 60 秒到 24 小时。
- 恢复时机：关联 ticket 变成 done/cancelled、显式 `reset`、TTL 到期、下次启动 reconcile。恢复前比较当前 override；若用户已经手工改过，不覆盖，记入 skipped。
- 恢复失败标记 `restore_failed` 并 60 秒后重试；启动时先 reconcile 再做其他恢复。
- 审计追加到 `stateDir/audit.jsonl`（0600）：grant/set、grant/active、grant/apply_failed、grant/restore_failed、grant/restored。
- 不改 worker tools、prompt 或 preset；只改 DSH 已有的权限 override。
- 已知限制：DSH 没有“清除 sandbox override”的 API，恢复时只能写回原 effective mode，可能留下一个同值的 override；effective 行为一致。

## 6. Request

request 就是一条普通会话消息，没有单独的消息类型体系。

- message 直接使用 DSH Session 支持的内容：文本、图片、文件等。
- 不做额外的文件分类、根目录白名单或专用上传流程；由 DSH 现有 message/content 能力处理。
- 必须带 `ticketId` 与 `note`；ticket 必须存在、未关闭、executor 等于目标 sessionId。缺 ticketId 抛 `ticketId is required`，缺 note 抛 `requires a non-empty note`，超长直接报错。
- note 最多 500 字。Host 在投递成功后、concludeTurn 之前，先把 note 与微信镜像写入副作用 outbox；有活跃 turn 时立即把 note 写入 ria.json（最多保留 100 条），插件 client 在 conversation.chat.turnTail 渲染为当前轮次末尾的卡片；没有活跃 turn 时留到下一次 turn/start、startup 或 30 秒 tick 补投。卡片独立于 turn process，不会被完成后折叠；不进入模型上下文，重启后仍可读取；通过 GET /api/dispatch-notes?sessionId&turn 查询。早期用 command/run + command/done，卡片被 ChatNodeSeat 当作 process member 折叠，真实 UI 不可见，已移除。
- 副作用失败不撤销已成功的派发。已持久化条目的后续卡片写入或微信投递失败由 outbox 重试并保留原因；outbox 入队本身写盘失败目前仅记录 warning，不能保证可重试或在状态中可见。
- 所有 request 都原样发送，Host 不在消息里插入任何 text part 或前缀。
- 防误发提示由 DispatchGuard 提供：为每个 agent 注册 name=dsh-ria:dispatch-guard、order=4100 的静态 system prompt section。文本是简短英文 2 句、无标题、不提 Ria 或其他会话名：最新消息若与本会话当前工作明显无关，先向用户确认再执行。只保留这一条约束，不再额外说明空闲或相关时应当放行。对所有 agent 生效，对普通会话无害。
- section 通过 agent.ctx.systemPrompt.section 安装；apply 时遍历 ctx.agents.list() 补装，并监听 agent/created；agent/disposed 和插件卸载时 dispose，避免同名 section 重载冲突。
- 开关在“设置 > Ria”，默认打开，持久化在 ria.json 的 settings.dispatchGuard。关闭后 text 返回空字符串，DSH 的 renderPrompt 丢弃空 section；开关只影响后续 system prompt，不改历史消息、tools 或 preset。
- 该提示只是行为约束，不是硬拦截；Host 看不到 worker 的内部上下文，无法判断是否真的发错。
- source 是 user-rpc，worker 看到的就是普通用户消息。
- requestId 每目标独立；重试复用同一个 requestId。
- 预检按目标逐个进行：ria 自己 / subagent → not_top_level；session 不存在 → session_missing；归档 → session_archived；cwd 不可用 → workspace_missing；executor 不匹配 → ticket_executor_mismatch。失败的结果带 code 与中文 message，不投递、不写 recentWorkers、不动 ticket；多目标可部分成功，只有全部成功才 concludeTurn。
- 成功投递后 ticket 变 working（记 attempt.lastRequestId），并把每个目标记入 recentWorkers（lastUsedAt、lastTicketId）；失败不记录。
- 默认 queue；用户明确要求打断时才 steer。
- pending request 记录 target、requestId、ticketId、content、mode；成功后删除，失败保留，重启后按原 requestId 重试。重试成功把 ticket 拉回 working 并清零 recovery.count。

关于这条提示的调研、替代方案和落地步骤，见 system-dispatch-guard.md；v0.23 已按其中的静态 section 方案实施，并增加设置页开关。

### 6.1 副作用 outbox

派发卡片、微信镜像以及恢复/blocked 提示都在“请求已经投递成功之后”发生。它们先写 `stateDir/outbox.json`，再由独立投递器执行，为已成功持久化的条目提供至少一次（at-least-once）投递，重启后继续按退避和重试上限处理；发送成功但送达状态未落盘时可能重复。派发接受到 outbox 落盘前的崩溃、入队写盘失败仍是未解决的可靠性窗口；这不是跨 ria.json/outbox.json 的原子事务。

- 条目：id、key、kind、payload、status（pending/failed/delivered）、attempts、due、createdAt、updatedAt、lastError?、deliveredAt?。kind 目前是 `dispatch_note` 与 `wechat_dispatch_note`。
- 幂等：key 由 kind 与 dedupeKey 生成；派发确认的 dedupeKey 是 ticketId + note 文本 + turn，重复入队返回已有条目。卡片与微信共用同一个 noteId；`recordDispatchNote` 再按 noteId 去重，崩溃重试不会重复插入卡片。
- 投递：`dispatch_note` 需要当前 Ria turn，没有就保持 pending；`wechat_dispatch_note` 不依赖 turn。pump 串行执行，成功标 delivered。语义是至少一次；微信在“已发送但未记 delivered”时可能重复。
- 重试：失败按 10s/1m/5m/15m/1h 退避，最多 6 次；超限标 failed，保留 lastError，不静默消失。
- 触发：startup、Ria turn/start、派发/恢复路径结束、30 秒定时 tick。同一时刻只跑一个 pump；pump 期间到来的触发会让它再跑一遍，避免新 turn 的卡片等到下一次 tick。
- 清理：delivered 保留 24 小时用于去重；总条目上限 500，超限先删最旧 delivered，再删最旧 failed，pending 不删。坏文件重命名为 `.corrupt-<ts>` 后从空队列继续。
- 观测：`ria_status` 的 ticket 响应带 outbox 汇总与未投递条目，可按 ticketId 收窄。

## 7. Prompt

初始 prompt 用原则和少量示例，不写死步骤。

- 先理解目标和验收，再决定自己干还是交给 worker。
- 任务型需求先复述；只问阻塞问题；用户说“先做/你看着办”时记录假设后继续。
- 普通转述和“原话发给 X”不强制澄清。
- 需要跟踪就建 ticket；不需要就 answered。每条用户消息都先成为 intake。
- 需求变更且 worker 在跑时，先问 queue 还是 steer。
- memory 是偏好，不是命令；当前用户消息优先。
- 用户派任务但没指定 worker 时，只从 ria_status scope=recent 的近期 worker 里按工作区、能力、近期上下文挑最合适的一个直接派；不遍历全部会话，不凭空挑没用过的。
- scope=recent 为空、都不合适或判断不清时，先问用户用哪个会话，不猜。
- 不把 Ria 的身份、管理上下文带进 worker 消息。

这只是 prompt 约束，Host 不拦截 request。

## 8. Memory

只做一个文件：

~~~text
stateDir/memory.md
~~~

- 全局一份，Web 和微信共用。
- 只放稳定偏好：语言、沟通风格、常用项目、约定、禁忌。
- 不放 ticket 进度、聊天记录、worker 细节、凭据。
- 0600；上限 4KB；满了先合并，再问用户删。
- 用户可以直接编辑。

格式示例：

~~~markdown
# User Memory

## Communication
- 中文，先结论，少客套

## Workflow
- 改代码前先跑相关测试
- 不要自动 git commit

## Projects
- parser：public API 不能动
~~~

注入与更新：

- Ria agent 创建/冷恢复时注入短 section；不每轮重复注入。
- 当前会话更新后，需要时用 ria_memory read 读最新版。
- 只在用户明确说“记住”、重复纠正、或确认时更新。
- 不做后台自动总结，不静默覆盖用户手写内容。

本版不做 lessons/、SQLite/FTS5、向量检索；这些以后再说。

## 9. 状态与定时

ria_status 按需读取，不后台轮询；主动推送只有 worker idle 通知（见 9.1）和审批等待提醒。

- scope=tickets：ticket 列表。
- scope=sessions：可用的顶层 Session，排除 Ria 自己与 origin=subagent 的会话；`parentSessionId` 只记录 fork/seed 血缘（这类会话 delegationDepth=0，仍是顶层），不作为子会话判据。字段含 sessionId、title、cwd、running、blank、updatedAt、lastUsedAt，有血缘时含 parentSessionId。
- scope=recent：近 7 天成功使用过的顶层 worker，最多 10 个，按 lastUsedAt 倒序；字段见第 5 节“近期 worker”。
- 可选 sessionId 查看一个会话的 running/queue/pendingInput/blank。

ria_read 只读最近消息，默认 30 条，最多 100 条，不 resume 冷会话。返回值同时带 queue（与 ria_queue list 相同的 pending 视图；冷会话为 null）。

ria_queue 管理一个顶层 worker 尚未执行的 pending 消息。list 返回 running 与 queue：queued 是下一轮执行的消息，steering 是当前轮插播，context 是其它非用户上下文；每项带 id、placement、可选 rpcId 和约 120 字 preview。remove 接受 itemId 或 rpcId（都给时 itemId 优先）；rpcId 就是 ria_request 返回的 requestId，是 Ria 找回排队消息的唯一句柄。撤回不可恢复，只删除仍 pending 的条目：不停止当前 turn、不改 ticket、不影响 recentWorkers。预检与 ria_request 一致，Ria 自己和 subagent 拒绝；找不到条目返回 queue_item_not_found，宿主其它失败返回 queue_remove_failed。

定时用官方 schedule_create/list/view/edit：

- target 只能是 this_session。
- title 带“Ria:”前缀；用完删除。
- 插件不实现 timer、不存 nextAt。

### 9.1 Worker idle 唤醒

Host 监听 agent/status（payload 为 { agent, status }）。当 status 变为 idle，且该 session 是至少一个 working ticket 的 executor 时，给 Ria 发一条 mode=queue 的普通消息。

- 只读：从 worker 事件日志读取最后一个 turn/end 的 reason，不写 worker，不改 worker prompt/tools，不 resume 冷 worker；动作是 ensure Ria 并 prompt Ria，且在 aborted(user) 时把对应 working ticket 标为 blocked。
- 排除 Ria 自身，避免自我唤醒循环。
- 只匹配 status=working 的 ticket；open/done/cancelled/blocked 不触发。
- 节流键是 workerSessionId + ticketId，默认 30 秒；多 ticket 分别计时，同一次事件只发一条消息。
- 文本固定以 [Worker idle] 开头，写“turn 已结束”和最后一轮 turn/end 的 outcome（completed、blocked、error、aborted(user) 等），要求 Ria 先 read 确认，不假设完成；等用户输入/决定时标 blocked，继续时发 continuation。
- 最后一轮是 aborted(user)（用户手动取消/叫停）时，通知改为“必须停下来等用户决定”，不再建议 continuation；Host 同步把对应 working ticket 标为 blocked，Ria 只向用户报告并询问下一步。aborted(parent/hook/disposed) 不是用户决定，保持原流程。completed/blocked 等其他原因也不被拦截。
- worker 明确拒绝任务没有独立事件，仍由 Ria 读消息判断；manager prompt 要求此时标 blocked 并停下来问用户，不自行改派、重发或换方案。
- idle 本身无法区分完成、等用户输入和明确拒绝；审批 pending 通常仍为 running，因此不会产生 idle 通知。
- 配置 notifyOnWorkerIdle（默认 true）、workerIdleThrottleMs（默认 30000，1 秒–10 分钟）；环境变量 DSH_RIA_WORKER_IDLE、DSH_RIA_WORKER_IDLE_THROTTLE_MS 优先。
- 日志记录 enabled/disabled、notify、throttled、no working ticket、Ria skip；投递失败只 warn，不重试。

## 10. 启动恢复

重启后 worker 的 turn 已经中断；恢复以未收敛 ticket 为单位，不再维护独立的 inFlight turn 记录。

| 情况 | 处理 |
|---|---|
| pending request：原消息没送达 | 用原 requestId 重试 |
| 已送达但 ticket 未完成 | 发一条恢复 prompt，让 Ria 先 read 再继续 |
| intake 还没有归宿 | 恢复 prompt 要求先 read 自己的会话，再 `ria_resolve` |

步骤：

1. 读 ria.json。
2. 重试 pending request；失败保留。
3. 如果原 request 仍在 pending 且重试成功，不追加 continuation。
4. 收集未收敛 ticket：`intake`、`open`、`working`；`forked` 只递归 `childTicketIds`，父容器本身不作为恢复单元；`blocked`/`failed`/`done`/`cancelled` 跳过。
5. 没有未收敛 ticket、也没有 pending request 就安静结束。
6. `recovery.count` 已经达到 3 的 ticket 不再发 prompt：标成 `blocked`，写入 blockedReason（自动恢复已达上限）与 `failure.code=recovery_exhausted`，产生一次 `recovery_exhausted` 卡片，然后跳过。
7. 只有存在 candidate 或 exhausted ticket 时才 ensure Ria。
8. 给 Ria 发**一条** prompt，逐条列出 ticketId、status、executor、goal、acceptance、原消息、开始时间、最近动作与 `recovery=n/3`；intake 要求先 `ria_read` 自己的会话再 `ria_resolve`，working 要求先读 worker 与工作区、检查已改文件和测试再判断继续/done/failed/blocked；绝不发两条。
9. candidate 的 `recovery.count` 加一；同一个 ticket 连续自动恢复最多 3 次。
10. 恢复计数按 ticket 存在 `recovery.count`；`ria_ticket` 更新、成功派发或用户重新打开都会归零。旧的顶层 `inFlight` 在 schema v2 迁移时转成 `open`（到上限时 `blocked`）ticket，`origin.kind=legacy_inflight`，迁移后不再有 `inFlight`。
11. Ria 先 read：
   - 已完成：done。
   - 需要用户/阻塞：blocked + blockedReason，报告用户。
   - 可继续：executor=sessionId 发 continuation；executor=self 自己继续。
12. startup recovery 本身抛错时，向 Ria 发送失败通知（错误内容 + 需要手动处理），不能只写日志。

continuation 要求 worker 先检查工作区、已改文件和测试，从中断处继续，不重复已完成部分。

## 11. 微信

微信客户端运行在 DSH 进程内，不启动 bridge 进程，不占端口，不用 UDS/socket。

- 复用 dsh-super-chat/wechat 的 login、wxweb、outbound 代码；入站桥接和状态由插件自己的 wechat/service.mjs 编排。
- 凭据和状态：stateDir/wechat/（creds.json、state.json），文件 0600。
- 有 creds 时启动自动恢复；DSH 重启通常不需要重新扫码。
- 微信来消息：原样作为普通用户消息投递给 Ria，不加前缀。
- Ria 的所有 assistant 回复都同步到微信。
- 微信消息只进入 Ria，不直接进 worker。
- 重连时待发文本超过 10 条，只补发最后 10 条，并先提示跳过了多少条。

### 11.1 长回复转 .md 文件

微信的普通 sendText 会按 1800 字切块，超过 4 块截断，长回复和复杂 Markdown 在微信里很难读。出站改为：每条 assistant 文本先判定，命中任一条件就发完整的 .md 文件；短消息和简单文本仍直接发文本，不多出附件。

判定条件是 OR：

- enabled 为真，且字符数超过 charThreshold。
- 有围栏代码块（三个反引号或三个波浪线）。
- 有 Markdown 表格（表头行 + 分隔行）。
- Markdown 标题数达到 headingCount。
- Markdown 链接数达到 linkCount。

默认值：enabled=true、charThreshold=800、codeBlock=true、table=true、headingCount=4、linkCount=6。阈值限制在 80–100000，标题/链接数限制在 1–50/1–500。

配置可以在 profile 的插件行里给 markdownFile，也可以被环境变量覆盖（环境变量优先）：

~~~yaml
- id: ria
  config:
    markdownFile:
      enabled: true
      charThreshold: 800
      codeBlock: true
      table: true
      headingCount: 4
      linkCount: 6
~~~

markdownFile 也可以直接写 false 关闭。环境变量优先于 profile 配置：DSH_RIA_MD_FILE、DSH_RIA_MD_THRESHOLD、DSH_RIA_MD_CODE、DSH_RIA_MD_TABLE、DSH_RIA_MD_HEADINGS、DSH_RIA_MD_LINKS。布尔值接受 1/true/yes/on 和 0/false/no/off。

发送：

- 文件名 ria-<Session id 后 8 位>-YYYYMMDD-HHmmss.md；内容是完整回复，不截断。
- 文件先在内存里，不落临时文件；Outbound 的文本和文件共用同一个串行队列。
- WebWxClient.sendFile 先 multipart 上传到网页版文件主机（file.wx.qq.com），拿到 MediaId/Signature，再发 Type=6 的 appmsg。
- 命中后先发一条短文本“（内容较长，已转为 Markdown 文件发送）”，再发文件，不重复正文。
- 上传或发送失败时回退文本，正文前加“（原回复已转为 Markdown 文件，但文件发送失败，以下改为文本）”。仍然失败就进 outbox，按重连策略处理。

微信设置放在 Ria 入口标题右侧的 chip：

- 宽侧边栏显示；折叠状态暂不显示。
- 点击打开弹层，调用 Host 的微信 status/start/login/logout。
- 不新增 sidebar 条目，不注册微信 main 面板。
- 这是 DOM 注入，用 MutationObserver 补插；参考 dsh-super-chat 的 SidebarShortcut。

### 11.2 暂停推送

暂停只关闭“Ria -> 微信”的出站推送；微信连接、登录态、长轮询和心跳都保持不变，不需要重新扫码，也不影响微信入站。

手动控制：

- POST /plugins/dsh-ria/api/wechat/pause，JSON body 为 { "paused": true } 或 { "paused": false }，可选 reason；paused 不是布尔值返回 400。
- GET /wechat/status 增加 paused、pausedBy、pauseReason、pausedAt、resumedAt、resumedBy；未暂停时 paused=false，时间字段为 null。
- 状态写入 wechat/state.json，DSH 重启后保持；带 creds 启动时，Outbound 在创建后立即套用暂停状态。

界面（chip 弹层）：

- 已登录时显示推送状态卡：正常为“推送中”；暂停为“已暂停推送”，并显示来源（“手动”或“自动（非微信通道消息）”）和暂停时间。
- 卡片右侧是“暂停推送 / 恢复推送”按钮；点击后 POST /wechat/pause，并直接用响应里的 status 刷新界面，不等下一次轮询。
- 弹层每 2 秒、侧边栏每 15 秒读取 status。发现 paused 由 false 变为 true 且 pausedBy=channel 时，弹层内显示 8 秒轻提示，侧边栏在右下角显示同样文案的浮层；不弹窗、不抢占输入焦点。
- chip 已登录且暂停时圆点变橙色，标题提示“微信推送已暂停”。
- 设置页“Ria”不重复放同一个开关，微信推送只保留 chip 弹层一个控制点。

自动切换：

- 只把 source.kind=user 的真实用户消息当作通道信号。微信入站 requestId 以 wx_ 开头；Web GUI、手机端等其他通道通常是裸 UUID。
- 非微信用户消息 -> 自动暂停，pausedBy=channel，reason=非微信通道消息。
- 微信用户消息 -> 自动恢复，pausedBy=channel，reason=微信消息。
- host_ 开头的 Host 合成消息（启动恢复、启动失败、worker idle 唤醒）不参与判断；source.kind=schedule 的官方定时提醒也不参与，避免把 Ria 自己的提醒当成用户切通道。
- 微信入站即使当前是手动暂停也会恢复：它同时是自动恢复的触发点。

优先级：

- 手动暂停 pausedBy=manual 不会被非微信消息的自动暂停覆盖；自动暂停被手动暂停拦下时记一条 info，不改暂停原因和时间。
- 手动暂停可以被微信入站恢复，也可以通过接口手动恢复；恢复后 resumedBy 记为实际触发方。
- 手动恢复后，下一条非微信用户消息会再次自动暂停，这是预期行为。

队列和在途消息：

- 正在发送中的那一条不打断，发送完成后才停止后续出站；尚未开始发送的排队文本/文件全部丢弃。
- 暂停期间不写微信内部 Outbound 队列：assistant 回复、系统提示和长回复转文件都在入队前被拦截并记录；插件副作用 outbox 是另一层，见 6.1。
- 暂停前已经在 outbox 里的待发消息保持不发送；恢复时再按重连积压策略补发（超过 10 条只发最后 10 条并先提示）。
- 暂停期间微信入站消息仍正常投递给 Ria，因此会话历史完整。

日志（logger 前缀 dsh-ria: wechat:）：

- 暂停：warn，pause: 后接 JSON，字段为 at、pausedBy、reason、dropped（本次丢弃条数）、inFlight（是否有在途消息）。
- 恢复：info，resume: 后接 JSON，字段为 at、resumedBy、reason、previousPausedBy。
- 丢弃：warn，dropped outbound while paused: 后接 JSON，字段为 at、riaSessionId、to（filehelper）、kind（assistant/system/text/file）、pausedBy、reason；text 另有 chars、preview，file 另有 name、bytes。
- 自动暂停被手动暂停拦下：info，auto pause ignored: manual pause is active。

### 11.3 派发 note 同步到微信

turn-tail 卡片是插件 client 渲染的，微信桥只转发 assistant/message 文本，因此卡片本身不会到微信。派发成功后，Host 额外把同一段 note 作为一条普通文本放进 WechatService 的 outbound 队列，与卡片并存。

- 触发点：ria_request 至少一个目标被 Host 接受且 note 通过校验；部分成功时确认附上失败目标结果，只有全成功结束 turn。当前 ria_request 的 ticketId 与 note 均必填，已移除 quick relay。
- 格式：任务为“📌 任务已派发：<note>”。只加一行前缀，不包长模板，note 原文不改。
- 网页派发卡片与微信确认共用同一个 note 原文；没有无 ticketId 或无 note 的 quick relay 例外。
- 通道：WechatService.sendDispatchNote 内部走 deliverAssistant -> Outbound.enqueue，因此和普通回复共用串行队列、markdown/长度判定和暂停开关；返回 true 才算送达。插件侧副作用 outbox 负责至少一次与重试，内部 Outbound 负责串行队列（不保证远端崩溃去重），两层不要混淆。
- 暂停：入队前检查 state.paused；durable 调用已暂停或离线时返回 deferred，不消耗失败次数。暂停期间不会绕过开关；恢复后由30秒 outbox tick 补投。真正网络错误才计失败退避，最多6次。
- 未登录：没有 outbound 时返回 false，由 outbox 重试；超过上限标 failed 并保留原因，不影响派发。
- 失败：不影响 ria_request 的成功结果，也不影响 concludeTurn；outbox 按 10s/1m/5m/15m/1h 最多重试 6 次，超限标 failed。因为语义是至少一次，已发送但未落盘时可能重复；卡片侧按 noteId 去重。
- 长度：前缀加 note 后按现有规则判断，阈值按包含前缀的完整文本计算；note 上限 500 字，默认 800 字阈值下不会转 .md，若配置更低阈值则照常转文件。
- 与 turn-tail 卡片的关系：网页显示卡片、微信收到文本是预期双份；两处使用同一个标题语义和同一段 note 原文，措辞一致。

### 11.4 图片（入站与出站）

配置为 wechatImage.inbound / wechatImage.outbound：两项默认都是 true；只认显式 boolean，缺省或非 boolean 时回落默认值。文本和文件路径不受入站开关影响。

- 出站提取：WechatService.deliverAssistant 在发送前调用 extractAssistantImages(text, workspaceRoots)，扫描 ![alt](path)（不扫描三反引号/三波浪线围栏内的示例）。path 必须是绝对路径，或相对 stateDir 与 dsh 进程 cwd 的路径；带 scheme 的地址不处理。
- 出站校验：statSync 必须是普通文件、大小 1B–20MB，读文件头识别 PNG/JPEG/GIF/WebP。命中则从文本中移除该 Markdown 图片语法并收集为 { name, buffer, mime, path }；缺失、非图片、超限或不可读时保留原 Markdown 文本。
- 出站顺序：短回复先 enqueue(clean) 再逐张 enqueueImage；长回复先发“已转为 Markdown 文件”提示与 .md（失败回退文本），最后逐张发图片。图片语法不进入 .md 正文，避免微信里显示破图。
- 出站失败：单张图片失败只记 warn；PauseError 照常上抛并计入暂停丢弃。Outbound.enqueueImage 失败会 reject，调用方可重试。
- 协议：Outbound.enqueueImage 与文本/文件共用同一条串行队列。WebWxClient.uploadMedia 抽出原 sendFile 的 multipart 单块上传，图片用 formMediaType=pic、uploadMediaType=3；随后 POST /webwxsendmsgimg，Msg.Type=3、MediaId 来自上传响应、Scene=0 仅 filehelper；Ret!==0 抛 WebWxError；MsgID 加入 sentIds。
- 入站触发：InboundBridge 用 isImageMessage 判断 MsgType 3。inbound=false 时仍走“目前只能接收文本消息”提示，不下载；inbound=true 时调用 deliverImageFromWechat，Content 里的 <img> 只当元数据（MsgId/mediaid/encryfilename），原文字单独提取，纯图片用“（用户发来一张图片）”占位。
- 入站下载：WebWxClient.downloadImage 复用当前 Cookie/skey/sid/pass_ticket，先 GET /cgi-bin/mmwebwx-bin/webwxgetmsgimg?MsgID&skey&mmweb_appid（不带 type，取原图），失败再试文件域名；有 mediaid 时再走 webwxgetmedia（sender/mediaid/encryfilename/fromuser/pass_ticket/webwx_data_ticket/sid）。requestBuffer 拒绝 JSON/文本响应、非 2xx 和超过上限的流；downloadImage 把空 Buffer 也视为失败。
- 入站校验与落盘：receiveInboundImage 依次检查 MsgType、stateDir、downloader、MsgID/MediaId、非空、大小（min(20MB, 宿主 imageLimits.maxImageBytes)）和文件头（PNG/JPEG/GIF/WebP）。成功后写到 <stateDir>/wechat-inbound/YYYYMMDD-HHMMSS-<MsgID>.<ext>，目录 0700、文件 0600，冲突追加 -2/-3；每次成功后删除超过 30 天的文件并只保留最近 500 个，清理失败只 warn。
- 入站投递：内容是“原文字（或占位）+ 图片已保存绝对路径”的 text part 加 { type:'image', mediaType, data, name }，投递前调用宿主 validateImageBatch/validateImage。携带图片的 prompt 失败时重试纯文本；下载/空/超限/类型/校验失败时投“原文字 + [图片接收失败：<原因>]”，并记 [wx inbound] image <id> rejected (<code>): <reason>，不静默丢消息。保存路径可直接用于后续 ria_request 的 attachments。
- outbound=false 时 extractAssistantImages 不运行，assistant 文本按原样发送；文本、.md 文件、暂停、去重和 outbox 路径不变。inbound=false 时入站图片不下载、不落盘，只回“目前只能接收文本消息”。

## 12. 状态文件

~~~text
stateDir/
  ria.json
  ria.json.v1.bak   # 首次从 schema v1 迁移时留下的备份
  outbox.json       # 副作用投递队列（dispatch note、微信镜像），0600
  tickets.log.jsonl   # 终态归档（追加），受 24h/50 条窗口控制
  tickets-YYYY-MM.jsonl # 按月滚动，保留 12 个月
  memory.md
  audit.jsonl      # 临时权限审计，0600
  wechat/
    creds.json      # 登录凭据，0600
    state.json      # seen 消息 id（上限 500）、outbox（上限 50）、暂停状态与时间
  wechat-inbound/   # 入站图片原图，YYYYMMDD-HHMMSS-<MsgID>.<ext>，目录 0700、文件 0600
~~~

没有 lessons、lock、briefs。`outbox.json` 是唯一独立于 ria.json 的副作用队列，不与微信内部的 Outbound 队列混用。

ria.json schema v4 只存 schemaVersion、riaSessionId、riaPreset、tickets、ticketFeedback、deliveries、grants、settings、recentWorkers、dispatchNotes（v3 可直接读，首次加载写 `ria.json.v3.bak` 后归一化为 v4；v2/v1 分别写 `.v2.bak`/`.v1.bak`）：

- tickets：8 态 ticket，字段见第 4 节；依赖工单带 dependsOn、readyAt、readyNotifiedAt、dependencyAlerts；checklist 为有序 {text, done}，最多 50 条、每条 ≤200 字，缺省为空。非终态全留，终态按 24h/50 条窗口保留。
- ticketFeedback：kind、code、ticketId、body（≤500）、card、mirror、workerTurn、at；每 ticket 保留最近若干条，5 秒内同 (ticketId,kind,code,workerTurn) 去重；与状态同一次 save。
- recentWorkers：sessionId -> lastUsedAt、lastTicketId?；只在 request 成功投递后写入，30 天后清理。
- settings：dispatchGuard（boolean，默认 true）、progressCards（boolean，默认 false）、wechatAutoPause（boolean，默认 true）。
- dispatchNotes：noteId、sessionId、turn、note、isTicket、at、ticketId?；最多保留 100 条，供 turn-tail 卡片读取。
- attention：ticket 内可选，blocked + waitingOn=user 时记录 kind、question、options?、askedAt、askedBy、ref?；离开 blocked 或关闭时清空。

outbox.json：version 与 entries。每条含 id、key、kind、payload、status、attempts、due、createdAt、updatedAt、lastError?、deliveredAt?；delivered 保留 24 小时，队列上限 500 条，pending 不清理。该文件由 outbox 自己原子写，不参与 ria.json 的 schema 版本。
- deliveries：deliveryId、targetSessionId、requestId、ticketId、content、mode、createdAt。
- grants：grantId、sessionId、ticketId、status、createdAt、expiresAt、before、after、reason、lastError。

写入：进程内 mutex、临时文件 + fsync + rename、0600。pending request 成功后删除，失败保留。v1 迁移先写 ria.json.v1.bak，v2 迁移先写 ria.json.v2.bak；迁移失败保留旧文件。

Session 日志由 DSH 持久化：

~~~text
DSH_HOME/sessions/<workspace-key>/session-<uuid>/session.v4.jsonl.zstd
~~~

ria.json 和 memory.md 都不存 transcript。

## 13. UI

- sidebar.panellist 注册 Ria，order 100，label "Ria"。
- 点击后瞬时 launcher -> ensure -> openSession。
- DSH 的正常会话界面要求 Session 属于一个 Workspace。ensure 在 stateDir 创建/复用标题为 Ria 的专用 Workspace，并用 workspaceId 创建 Session；旧 Ria 通过 attachSession 补挂。工作区列表会多这一项，这是输入框可用的必要条件。
- 不做常驻看板；任务看板是侧栏入口打开的全屏只读 overlay，单画布按创建顺序每 3 张工单一列、依赖右移；纵轴按 workspace 分成水平项目带，带高随行数自适应，带内独立换行与行对齐，卡片不跨带，项目标签在带顶左侧 sticky，跨带只画箭头。默认最新 60 张工单，向左滚动分页加载更早的工单。
- 新建 Ria 第一次打开（会话还没有任何 turn）时，输入框上方显示一张欢迎卡片：提示选模型、设置权限（建议 danger-full-access + 审批策略）、直接说目标。
- 欢迎卡片是 client 侧渲染：注册在 `conversation.input.dock`（id=ria-welcome，order 5），只在当前会话等于 Ria 且 `blank` 时显示，发出第一条消息后自动消失；不写 session 日志、不占 turn、不调用模型、不进入模型上下文。
- 早期实现是 Host 侧由 Session.append 写一个合成的完整 turn（turn 1/step 1）。该 turn 的 assistant/message 会成为 surface 的首个节点，排在真实 turn 的 system/message 之前，DSH session-format v4 校验要求 system/message 是 protected first surface head，因此重启 resume 报 corrupt（`system/message requires a protected first surface head`），已移除。
- 带 ticketId 的派发 note 由 Host 记录到 ria.json（最多保留 100 条），插件 client 在 `conversation.chat.turnTail` slot 渲染为当前轮次末尾的卡片，标题「任务已派发」/「消息已转交」。卡片不属于 turn process，不会被完成后折叠；不进入模型上下文；通过 GET /api/dispatch-notes?sessionId&turn 读取。早期用 command/run + command/done，卡片被 ChatNodeSeat 当作 process member 折叠，真实 UI 不可见，已移除。
- 微信 chip 在 Ria 入口标题右侧，点击打开微信弹层。
- 设置页注册 settings.section：id=ria-settings、order=25、label=Ria；外层是独立的白色卡片（#ffffff、浅灰边框、固定深色文字），不依赖 DSH 主题变量，背景图下仍可读。卡片内有两个开关：“任务转交提示”和“自动暂停微信推送”，默认都打开，POST /settings 持久化。说明文字明确：前者只影响后续 system prompt，不改 worker 历史、工具或预设；后者关闭后非微信消息不再自动暂停。

## 14. 安全

- UI API 校验 DSH 同源。
- 微信客户端在进程内，没有额外 loopback API。
- memory.md 0600；禁止写凭据/token。
- 不自动上传、不遥测。
- 单 Host 假设；两个 DSH 实例可能双开。
- 删除 Ria 不删除 ticket、memory.md 和微信凭据。

## 15. 阶段

Phase 0：验证 PTC preset 创建（agentPreset=ptc）、run_code SDK 暴露 ria_* 工具、user-rpc、sidebar launcher、schedule、微信扫码/收发。

Phase 1（历史阶段，工具数量不代表当前 12 个工具）：单例、ensure、ticket、9 个工具、request、read、pending request 重试、入口。

Phase 2：启动恢复、continuation、recoveryCount。

Phase 3：memory.md、remember/forget、冷启动注入、case 集输出与按路径保存。

Phase 4：微信进程内服务、回复同步、积压 skip、入口 chip。

Phase 5：审批可见性 observer、ticket 自动 blocked+attention、approval 卡片/微信提醒、ria_approval list、清理/TTL 与 startup 对账。

Phase 6：新建 Ria 的一次性欢迎提示（最初是合成 assistant turn 1，不调用模型；合成 turn 早于真实 system/message，v4 校验失败，已改为 client 卡片，见第 13 节）。

Phase 7：任务派发防误发提示（最初实现为仅带 ticketId 的 request 插入固定 text part；Phase 13 已改为静态 system prompt section 并删除前缀）。

Phase 8：临时 worker 权限 grant（set/list/reset、原值记录、ticket 关闭/过期/启动恢复、审计）。

Phase 9：微信出站长回复/复杂 Markdown 转 .md 文件（可配置阈值和复杂度规则、完整文件、失败回退文本）。

Phase 10：恢复上限可见性（达到上限的 task 标 blocked + blockedReason，通知 Ria 并列出放弃的 task；startup 异常也通知；ticket 更新/成功派发清零 recoveryCount）。

Phase 11：worker idle 自动唤醒（agent/status 只读监听、working ticket executor 过滤、排除 Ria、按 worker+task 30 秒节流、可配置开关、mock 测试）；读取最后一个 turn/end 的 reason，aborted(user) 时标 blocked 并改为“停下来问用户”。

Phase 12：微信暂停推送（只停出站、连接保持；手动 pause/status API；非微信用户消息自动暂停、微信入站自动恢复；manual/channel 优先级；队列丢弃与在途完成；持久化与重启恢复）。

Phase 13：静态 system prompt section 防误发提示（对所有 agent 安装、可开关、默认开启），移除 ticket 派发的消息前缀，增加设置页。

Phase 14：近期 worker 选择（成功 request 记录 recentWorkers；status 增加 scope=recent 与 title/lastUsedAt；manager prompt 规定默认从近期 worker 里挑，空或不确定时问用户）。

Phase 15：微信暂停推送 UI（chip 弹层显示“推送中 / 已暂停推送”、来源与时间、手动暂停/恢复按钮；自动暂停时弹层内和侧边栏右下角各一条 8 秒轻提示；chip 圆点显示暂停色）。

Phase 16：note 硬约束（带 ticketId 的 request 必须传 note，最多 500 字；缺失/空白/超长直接报错且不投递；Host 在 concludeTurn 前把 note 入副作用 outbox，有活跃 turn 时写入 ria.json，由 client 在 conversation.chat.turnTail 渲染可见卡片；已持久化条目的后续投递写入失败退避重试；当时 quick relay 不受影响（历史行为，Phase 20 已移除））。

Phase 17：派发 note 同步微信（ticket note 发“📌 任务已派发：<note>”，当时带 note 的 quick relay 发“📌 消息已转交：<note>”（历史行为，Phase 20 已移除）；走 outbox + sendDispatchNote；暂停/未登录/发送失败由 outbox 退避重试，不影响派发和 concludeTurn）。

Phase 18：微信图片接口预留（识别 MsgType 3、入站下载/转换/投递签名与 TODO、出站 enqueueImage 签名与 TODO；当时 inbound/outbound 默认 false，文本路径不变；Phase 26 已补齐入站）。

Phase 19：完整任务模型 P0。schema v2（tickets[]、8 态、waitingOn、attempts、recovery、parent/child、resolution、revision、ticketFeedback）；RiaStore.transitionTicket 唯一状态入口与 28 条转移/10 条不变量；agent/pre-step 自动登记 intake + ria_resolve 定性 + turn-stopping 兜底 + turn/end 异常收尾四层强制点；merge（M1 消息并入、M2 ticket→ticket）；终态 24h/50 条窗口归档与月度日志、history/ticketId/reopen；删除顶层 inFlight，改为扫未收敛 ticket 恢复，恢复上限按 ticket 计。

Phase 20：任务术语改名为 ticket：ria_task→ria_ticket、taskId→ticketId、内部 store 与状态机字段统一；ria_request 的 ticketId 与 note 均必填，移除 quick relay。

Phase 21：微信出站图片。assistant 文本中的本机 Markdown 图片提取为图片消息（绝对或相对 stateDir/cwd，按文件头识别 PNG/JPEG/GIF/WebP，上限 20MB，跳过围栏代码）；与文本/.md 共用串行队列、暂停门禁和去重；图片上传用 mediatype=pic、MediaType=3，发送用 webwxsendmsgimg Type=3；outbound 默认 true。该阶段入站仍预留，Phase 26 补齐。

Phase 22：副作用 outbox（stateDir/outbox.json；dispatch note、微信镜像、恢复/blocked 提示先入队；有 turn 立即投，无 turn 等 turn/start、startup 或 30 秒 tick；至少一次、幂等 noteId、10s/1m/5m/15m/1h 最多 6 次、failed 保留、delivered 24h 清理、上限 500、ria_status 可查）。

Phase 23：结构化 attention（blocked + waitingOn=user 时可带 kind/question/options/askedAt/askedBy/ref；旧 blockedReason 兼容；离开 blocked 或关闭清空；ria_status 带 attentionOverview）。

Phase 24：worker 模型选择。ria_spawn 支持 model/provider/reasoningEffort，create 前解析注册表、create 后 selectModel；新增 ria_model 改已存在会话（含 Ria 自己，subagent 拒绝）；失败码 model_not_found；ria_status 的 sessions/recent 暴露 provider/model/reasoningEffort。

Phase 25：排队消息控制。ria_queue 支持 list/remove，读取 sessionController.state 的 pending 队列（queued/steering/context），只删 pending、不 cancel turn、不改 ticket、不影响 recentWorkers；remove 支持 itemId 或 rpcId（ria_request 的 requestId）；ria_read 返回值增加 queue。

Phase 27：ticket 排队与依赖 P0。schema v3（dependsOn/readyAt/readyNotifiedAt/dependencyAlerts，兼容读 v2）；`open + waitingOn=dependency` 作为等待态，依赖全部 done 后转 ready 并写 queueToken；outbox 新增 queue_wake/queue_blocked，pump 合并同批就绪工单、按 token 幂等、turn/end 与 startup 补泵；startup reconcileDependencies 并把排队摘要并进恢复 prompt（ready 工单不重复列入恢复单位）；ria_status 每个工单带 queueState/queueText/blockedBy，scope=tickets 带 queue 汇总；级联取消与 merge 依赖边转移；`ria_request` 对依赖工单校验 queueToken，对忙碌 worker 的 queue 投递返回 worker_busy，steer 仅允许信息同步。微信入站图片见 Phase 26。InboundBridge 识别 MsgType 3 后由 WebWxClient.downloadImage 复用登录态取原图（webwxgetmsgimg，失败回落文件域名与 webwxgetmedia）；receiveInboundImage 校验大小/文件头并落盘 stateDir/wechat-inbound（30 天/500 个清理）；以原文字或占位加 image 内容块投给 Ria，成功后路径可直接用于 ria_request attachments；失败仍投文字并附 `[图片接收失败：原因]`；inbound 默认改为 true。

Phase 29：ticket checklist。schema v3→v4，旧文件原样读入、无 checklist 视为空，首次写前备份 `ria.json.v3.bak`；`ria_ticket` 支持 checklist 追加/保留勾选、`replaceAll` 整表重建、`drop` 删旧索引与 `check:{index,done}` 单项切换（错误码 checklist_invalid / checklist_index，终态拒绝 check）。`ticketSummary`、`ria_status` 与看板卡片带 progress（已完成/总数），归档摘要记录 total/done 与最多 5 条未勾项；manager prompt 要求多步任务先建清单、完成一步勾一项、`[Worker idle]` 先读清单再决定续派。

Phase 30：任务看板重做与归档日志改名。看板改为单画布：按 createdAt 排序、每 3 张工单一列、依赖列右移；纵轴按 workspace 分成水平项目带，带顶留标签条并在横向滚动时 sticky，带高按实际行数自适应，带内独立换行、上游行中位数只在同带内生效，卡片不跨带，跨带依赖只画箭头；卡片 160×58 只显示 goal 摘要、状态·执行者与清单进度，悬停高亮整条上下游链并显示完整信息浮层（含依赖数、清单、排队原因、时间）。`GET /board` 增加 limit（默认 60，1–200）/before 分页与 page 元数据、dependentCount、archived，合并热存与归档日志；客户端默认加载最新一页并停在最右，向左滚动按 before 加载更早。归档日志新写入 `tickets.log.jsonl` / `tickets-YYYY-MM.jsonl`，启动时幂等迁移旧 `tasks.*`，读取端兼容并去重。

Phase 28：会话改名工具。新增 `ria_title({ sessionId, title })`，走宿主 `sessionController.rename`，只改会话名，不发消息、不建 ticket、不唤醒 worker；预检复用 `sessionProblem`（存在、顶层、未归档、cwd 可用），允许改 Ria 自己，subagent 一律拒绝；空标题或宿主 `session/title-invalid` 映射为 `title_invalid` 并保留宿主原始 message；成功返回 accepted title 与已知 previous。`ria_spawn` 的 title 设置复用同一 helper，返回值语义不变（失败仍只写 `titleError`）。

## 16. 验收

1. 点击入口只创建一个 Ria。
2. Ria 以 agentPreset=ptc 创建；模型只直接看到 run_code，12 个 ria_* 通过 SDK 可用。
3. 没有 attach/detach。
4. request 在 worker 中显示为普通用户消息，支持 DSH 支持的消息类型；ticket 派发原样发送，不加消息前缀；ria_request 必须带 ticketId 与 note。
5. 一个 ticket 只有一个 executor；forked 父容器 executor=null，子 ticket 各自独立。每条真实用户消息都在 pre-step 登记为 intake，并在本 turn 经 ria_resolve 定性，或被 turn-stopping 兜底 blocked。
6. 重启后 pending request 原 requestId 重试；已送达 ticket 用新 requestId 继续。
7. 同一 ticket 连续自动恢复最多 3 次；达到上限后标 blocked 并通知，不静默跳过；ticket 更新、成功派发或 reopen 清零 recovery.count。
7.1. startup recovery 抛错时向 Ria 发送失败通知，不只写日志。
8. memory.md 跨重启保留；冷启动注入；remember/forget 可用；当前消息优先。
9. 没有 lessons/FTS5；经验默认只在上下文，用户给路径才写文件。
10. 微信进程内运行，无 bridge 端口/socket；消息进 Ria，回复回微信。
11. 微信积压超过 10 条时只发最后 10 条并提示。
12. 微信 chip 在 Ria 入口右侧，宽侧边栏显示。
13. 审批 observer 只记录活跃 ticket executor，记录后调用 next()，从不改变审批结果；abort/超时/重启后不残留 pending。
14. 新建 Ria 的首次打开显示一次欢迎卡片；只在会话 blank 时由 client 渲染，不写 session 日志、不占 turn 和用户消息位、不调用模型；已存在/重启不重复。
15. 防误发提示由 agent 作用域 system prompt section 提供，对所有 agent 生效；要求 worker 对明显无关的消息先确认；设置页可关闭，关闭后 text 为空；ticket 消息内容不变。
16. 临时权限只能由用户明确指令触发；set 需要 userConfirmed=true；记录原值；ticket close/reset/expiry/startup 恢复；手工改动跳过；审计可查。
17. 微信长回复/复杂 Markdown 按可配置规则转完整 .md 文件；短消息不变；文件发送失败回退文本并提示。
18. 达到恢复上限的 ticket 不再停留在 working；状态为 blocked，blockedReason 可见，且 Ria 收到包含 ticketId/executor/goal 的通知。
19. startup recovery 异常时 Ria 收到失败通知；通知失败不能吞掉原始错误日志。
20. worker 结束 turn 变 idle 时，只有 working ticket 的 executor 触发一次通知；Ria 自己、非 working ticket、节流窗口内重复 idle 都不触发。
21. idle 通知只读 worker，不写 worker、不 resume 冷会话；通知文本要求 read 确认且不假设完成。
22. idle 通知默认开启，可通过配置或环境变量一键关闭；关闭后不注册监听，日志说明原因。
23. 通知投递失败只记 warn，不影响 worker 状态，也不改变 ticket。
24. 微信暂停只停出站，连接、登录态、轮询和入站不受影响，不需要重新扫码。
25. 手动暂停/恢复通过 POST /wechat/pause，状态在 GET /wechat/status 可见，并跨 DSH 重启保持。
26. 非微信用户消息自动暂停，微信入站自动恢复；host_ 合成消息和 schedule 提醒不触发切换；设置 wechatAutoPause=false 时非微信消息既不暂停也不改 pausedBy/pauseReason，已处于 channel 暂停则保持原状。
27. 手动暂停不被自动暂停覆盖；微信入站可以恢复手动暂停；手动恢复后下一条非微信消息再次暂停。
28. 暂停期间在途消息发送完成，微信内部 Outbound 队列的排队消息丢弃并记录日志；插件副作用 outbox 保持 pending，恢复后按退避或下一次 tick 补投。
29. 暂停相关测试覆盖手动开关、自动切换、合成消息过滤、优先级、队列竞态、日志和重启持久化。
30. 带 ticketId 派发必须传 note（最多 500 字）；缺失、空白或超长直接报错，不投递、不 concludeTurn；成功后 Host 把 note 与微信镜像入 outbox，有活跃 turn 时写入 ria.json，由 client 在 conversation.chat.turnTail 渲染为当前轮次末尾的可见卡片，再 concludeTurn；已持久化条目的后续投递写入失败退避重试并保留原因；入队写盘失败不在此保证内。ria_request 的 ticketId 与 note 均必填，没有 quick relay 例外。
31. 设置页默认 dispatchGuard=true、wechatAutoPause=true；关闭 dispatchGuard 后所有已安装 section 的 text 返回空字符串；POST /settings 接受 dispatchGuard 和/或 wechatAutoPause（至少一个 boolean，非法值 400）并持久化到 ria.json；GET /state 与 ria_status 可见 settings。
32. manager prompt 明确：用户未指定 worker 时只从 scope=recent 选择，不遍历全部会话，不凭空挑没用过的；没有合适候选时先问用户。
33. “近期用过”定义为成功 ria_request 过的顶层 worker，窗口 7 天、最多 10 个、保留 30 天；task 创建/更新不算，用户手工会话不算。
34. scope=recent 返回 sessionId、title、cwd、lastUsedAt、lastTicketGoal、lastTicketStatus；scope=sessions 也带 title、lastUsedAt；缺失字段省略且输出 lossless。
35. 投递失败不更新 recentWorkers；只有成功派发才更新 lastUsedAt 和 lastTicketId。
36. 微信弹层显示推送状态（正常“推送中”，暂停“已暂停推送”+ 来源 + 时间），按钮可手动暂停/恢复并立即刷新；自动暂停时只出现轻提示，不弹窗；设置页只提供“自动暂停”策略开关，不重复提供暂停/恢复按钮。
37. ticket 派发成功后，微信收到一条“📌 任务已派发：<note>”。note 走副作用 outbox 再进 sendDispatchNote：暂停/未登录/发送失败按 10s/1m/5m/15m/1h 最多重试 6 次，failed 保留原因，不影响派发和 concludeTurn。网页卡片与微信文本并存，使用同一段 note 原文。
38. 微信图片双向可用：出站把 assistant 文本里指向本机存在图片文件的 Markdown 图片作为微信图片发出，图片语法从文本中移除，走与文本/.md 相同的串行队列和暂停门禁；入站把 MsgType 3 的原图下载、校验后落盘到 stateDir/wechat-inbound 并作为 text+image 用户消息投给 Ria，纯图片有占位文字；下载/超限/类型/校验失败仍投原文字并附 `[图片接收失败：<原因>]`；inbound/outbound 默认都是 true，可分别关闭。
39. 派发卡片、微信镜像、恢复/blocked 提示都先写副作用 outbox；已持久化条目有活跃 turn 立即投 card，无 turn 留待补投；至少一次、幂等 noteId、失败退避且 failed 可见；ria_status 能按 ticketId 查看。
40. blocked + waitingOn=user 的 ticket 可带结构化 attention；旧 blockedReason 仍可读；离开 blocked 或关闭清空；ria_approval 只读 worker 审批，与 attention 不混。
41. ria_spawn 可在创建时指定模型；ria_model 可改已存在顶层会话（含 Ria 自己，不含 subagent）；未知/歧义模型返回 model_not_found，不在创建前留下会话；ria_status 的 sessions/recent 带当前 provider/model/reasoningEffort。
42. ria_queue 可列出 pending 队列（queued/steering/context 三种 placement，冷会话 queue=null）并按 itemId 或 rpcId 撤回；rpcId 来自 ria_request 的 requestId；找不到返回 queue_item_not_found，宿主其它失败返回 queue_remove_failed；撤回不停止当前 turn、不改 ticket、不影响 recentWorkers；ria_read 返回同一份 queue。
43. channel 自动暂停真正从运行态转入时，副作用 outbox 只入队一条提示，dedupeKey 为 pausedAt；该提示允许在暂停态发出（allowPaused），但只此一条，不放行后续推送；发送失败按 outbox 退避重试，最终失败只记日志；微信未连接不排，手动暂停不排。

44. ria_title 只改会话名：不发消息、不建 ticket、不唤醒 worker、不改其它状态；预检覆盖 session_missing/not_top_level/session_archived/workspace_missing，subagent 拒绝，允许改 Ria 自己；空标题或宿主 `session/title-invalid` 返回 title_invalid 并带宿主原始 message；成功返回 accepted title，已知 previous 时附上。

## 17. 已确认

- ticket 单 executor；广播建多个 ticket。
- Ria 所有 assistant 回复同步微信。
- 微信积压 N=10。
- memory 只做 memory.md，不做 lessons/FTS5。
- 微信设置在入口右侧 chip。
- 微信长回复/复杂 Markdown 转 .md：默认 800 字，代码块/表格/4 标题/6 链接任一命中。
- request 是普通会话消息，使用 DSH 支持的消息类型。
- worker idle 通知默认开启，节流 30 秒；只对 working ticket 的 executor 触发。
- 微信暂停默认不启用；手动 pause 优先于自动 pause；微信入站总是恢复。
- 防误发提示使用静态 system prompt section，对所有 agent 生效；任务消息不加前缀。
- 设置页提供 dispatchGuard 与 wechatAutoPause 开关，默认都打开。
- 派发 note 先写副作用 outbox；有活跃 turn 时记录到 ria.json 供网页卡片读取，微信镜像由 outbox 投递；当前 ria_request 的 ticketId 与 note 均必填，已移除 quick relay。
- 微信出站图片只发本机文件：assistant 文本里的 Markdown 图片路径必须落在 stateDir、进程 cwd 或绝对路径；不支持远程 URL、DSH imagePart 或粘贴图片。入站图片会下载原图并落盘到 stateDir/wechat-inbound，不支持从 CDN URL 直接引用。

## 18. 风险

| 风险 | 处理 |
|---|---|
| PTC preset/runtime 不可用 | Ria 无法创建或工具不可见 | ensure 明确报错；不静默退回 standard |
| 已有 Ria 不是 PTC | preset 不一致 | 提示重建/迁移，不自动改 |
| PTC SDK 未包含自定义工具 | Ria 无法调用 ria_* 工具 | Phase 0 验证注册时序；必要时延迟 SDK 生成 |
| ticket 状态依赖 Ria 维护 | 转移表 + 四层强制点 + 重启先 read；用户可纠正 |
| 自动恢复误判 | 先 read；连续最多 3 次；达到上限标 blocked 并通知 |
| 恢复额度被无关重启耗尽 | ticket 更新或成功派发清零 recoveryCount；达到上限仍可见可处理 |
| 启动恢复失败无感知 | catch 中除日志外，再向 Ria 发失败通知；通知异常单独记录 |
| memory 过期/膨胀 | 当前消息优先；4KB 上限；用户可删 |
| 微信全量同步 | 已接受；后续可做 turn 关联 |
| 微信长连接绑 DSH 进程 | 重启加载 creds 重连，通常不扫码 |
| 微信文件上传协议随网页版变化 | 规则命中时尝试上传/发 appmsg；任一步失败回退文本并提示 |
| 入口 chip 是 DOM 注入 | MutationObserver；宽侧边栏才显示 |
| 欢迎消息写进 session 日志 | 合成 turn 的 assistant/message 早于真实 system/message，v4 校验失败（system/message requires a protected first surface head），重启 resume corrupt；已改为纯 client 卡片，不写日志 |
| 临时权限被滥用 | 只能用户明确指令 + userConfirmed；单 worker、单 grant、TTL 上限 24h；ticket close/启动恢复；审计 |
| 恢复时覆盖用户手工改动 | 比较当前 override，不一致则跳过并记录 |
| idle 误判为完成 | 通知只写 turn 已结束；要求 read 确认；等用户输入时标 blocked |
| idle 通知刷屏/自我唤醒 | 排除 Ria；按 worker+task 30 秒节流；只匹配 working ticket |
| 通知投递失败 | 只 warn，不重试；worker 状态不受影响 |
| sandbox override 无法清除 | 写回原 effective mode，行为一致但可能保留同值 override |
| 暂停与在途出站竞态 | 微信 Outbound 的在途一条发完即止，排队丢弃并记日志；插件副作用 outbox 在暂停时保持 pending，恢复后或下一次 tick/startup 补投 |
| 自动暂停误判合成消息 | host_ 前缀 + source.kind=user 双重过滤；schedule 不参与 |
| 派发只调工具不写回复 | note 是工具参数硬约束：缺失/空白/超长直接报错且不投递；成功后 Host 先把卡片和微信镜像写入 outbox，有活跃 turn 时再记录可见 turn-tail 卡片，然后 concludeTurn |
| command 卡片被 turn process 折叠 | 已放弃 command 事件；改用 conversation.chat.turnTail，卡片在轮次末尾独立渲染，不进入模型上下文 |
| note 卡片只存在于 Host 状态 | 有活跃 turn 时 note 写入 ria.json（最多 100 条）；没有 turn 时留在 outbox，下一次 turn/start 补投；client 通过 HTTP 读取；卡片不依赖 session log，也不会进入模型上下文 |
| system prompt section 是行为约束 | 模型仍可能忽略；设置页只开关提示，不改变 worker 的 tools/preset/历史，也不做硬拦截 |
| 插件重载残留同名 section | apply 统一 dispose；按 agent id 去重；安装失败只 warn，不阻断加载 |
| 手动暂停被自动覆盖 | manual 优先；只有微信入站能清除 manual，并明确记录 resumedBy |
| 微信 note 与网页卡片看起来重复 | 预期双份：网页是卡片、微信是文本；使用同一标题语义和同一段 note 原文，不是重复推送 |
| 微信 note 发送失败或未登录 | 进副作用 outbox 按 10s/1m/5m/15m/1h 退避重试，6 次后 failed 并保留原因；不影响派发和 concludeTurn |
| 微信 note 绕过暂停开关 | 统一走 sendDispatchNote -> deliverAssistant -> Outbound.enqueue；暂停时不实际外发并返回 false，由 outbox 重试，恢复后若仍在窗口内补发 |
| 副作用至少一次导致重复 | 微信在“已发送但未记 delivered”时可能重复；卡片按 noteId 去重；可接受，避免静默丢失 |
| 补投的派发确认已过时 | 有活跃 turn 立即投；无 turn 时排队到下一次 turn/start，可能晚到；note 原文含任务上下文，用户可据此判断，丢失更差 |
| outbox 文件膨胀或损坏 | delivered 保留 24h、总上限 500，pending 不清理；坏 JSON 改名 `.corrupt-<ts>` 后从空队列继续 |
| attention 与 blockedReason 漂移 | blocked+waitingOn=user 才允许 attention；没有 question 时用 blockedReason 兜底；离开 blocked/关闭自动清空 |
| 出站图片被当成通用图床 | 只扫描 assistant 文本里的 Markdown 图片，只接受本机 stateDir/cwd/绝对路径和四种图片文件头；远程 URL、DSH imagePart 和粘贴图片都不处理 |
| 图片发送失败拖垮整条回复 | 文本先发；单张图片失败只 warn，PauseError 按暂停规则丢弃；缺失/非图片在提取阶段就保留原 Markdown 文本 |
| 入站图片协议变化或下载失败 | webwxgetmsgimg 失败回落文件域名和 webwxgetmedia；仍失败则投原文字并附 `[图片接收失败：原因]`，不静默丢消息 |
| 入站图片占满磁盘 | 保存到 stateDir/wechat-inbound，目录 0700、文件 0600；每次成功落盘后删除超过 30 天的文件并只保留最近 500 个，清理失败只 warn |
| 入站图片过大或伪装类型 | 上限取 20MB 与宿主 imageLimits.maxImageBytes 的较小值，按文件头只认 PNG/JPEG/GIF/WebP；拒绝后仍投文字 |
| 排队消息撤回不可恢复 | 只接受 itemId/rpcId，rpcId 来自 ria_request 的 requestId；先 list 核对 preview 再 remove；remove 只删 pending，不停止当前 turn |

## 19. 总结

全局一个 Ria，PTC preset（agentPreset=ptc）+ 管理者 prompt、memory.md 和 12 个工具；模型通过 run_code SDK 调用工具；用 ticket 管理谁做什么，request 就是普通会话消息；通过可开关的 agent system prompt section 提供通用防误发提示（简短英文，不提具体会话），任务消息不加前缀；派发必须提供 note，Host 记录后由 client 在 turn 末尾显示卡片，并把同一段 note 以“📌 任务已派发”文本同步微信，然后结束本轮；worker idle 时自动唤醒 Ria（只读事件、30 秒节流）；重启按未收敛 ticket 继续；派发卡片、微信镜像和恢复提示走副作用 outbox，至少一次、失败退避、failed 可见；blocked + waitingOn=user 的 ticket 可带结构化 attention，说明在等用户回答什么；微信客户端进程内运行，长回复/复杂 Markdown 自动转 .md 文件；推送可暂停（手动或按消息通道自动切换），暂停只停出站、连接保持；新建会话在 blank 状态显示一张 client 侧欢迎卡片（不写日志、不调用模型）；微信图片双向可用：出站把 assistant 文本里的本机 Markdown 图片作为图片发出；入站下载微信原图、校验落盘后以“文字+图片”投给 Ria，失败仍投文字并附原因。

## 20. 实现状态

截至当前版本：

当前状态：单例与侧边栏入口、PTC 创建、ticket 任务模型（intake、8 态状态机、resolve 定性、merge、归档、重启恢复、dependsOn 排队与依赖唤醒）、转述与 note 卡片、worker 完成自动唤醒、审批可见性（自动 blocked+attention、卡片/微信提醒、TTL 与重启对账）与临时权限、worker 模型选择、附件投递、排队消息撤回、结构化 attention、ticket checklist、副作用 outbox、worker 会话改名，以及进程内微信（文本、.md、本机图片出站、图片入站，推送可暂停）均已实现。已验证环境为 DSH 0.2.2-rc.1、Node 26，使用真实 Web profile 的隔离副本。逐阶段的落地记录见第 15 节。

- Phase 0–30 已实现；Phase 0–4、Phase 6、Phase 13 和 Phase 16 的 turn-tail 卡片通过隔离环境的真实 DSH 验证，其余阶段由单元测试和 smoke 覆盖。Phase 16 的截图使用手工写入 ria.json 的 note 验证渲染；真实 toolRequest 写入路径由 smoke 覆盖。
- Phase 17 的微信 note 镜像由 test/wechat.mjs 和 smoke 覆盖：ticket 格式、未登录/暂停/发送异常不影响派发和 concludeTurn，失败条目进入副作用 outbox 并按退避补投；没有用真实微信账号验证实际收件。
- 副作用 outbox 由 test/outbox.mjs 覆盖：幂等入队、重载、退避与 6 次上限、delivered 清理、坏文件恢复、无活跃 turn 排队、turn 开始后补投、失败原因可见、startup 补投；smoke 覆盖卡片写入失败仍记录 note、微信异常后按 due 重试并 delivered。
- 结构化 attention 由 test/attention.mjs 覆盖：设置/读取/清空、旧 blockedReason 工单、ria_status 输出；ria_approval 仍只读 worker 审批，不处理 attention。
- Phase 28 的 ria_title 由 test/title.mjs 覆盖：成功改名与 previous、session_missing、subagent 的 not_top_level、归档、宿主 title_invalid 原 message 透传和改 Ria 自己；失败路径都不产生 rename 副作用。
- Phase 26 的入站图片由 test/wechat-image-inbound.mjs 与 test/wechat.mjs 覆盖：下载主请求失败后回落 webwxgetmedia、Cookie 透传、Content-Length/流式超限、无 Cookie 错误传播、落盘命名与重名、纯图片占位、带文字保留、下载失败/空/超限/未知类型降级、30 天与 500 个清理、宿主附件校验失败与图片投递失败回退纯文本、InboundBridge 投递 [text,image]；没有用真实微信账号验证原图下载。
- Phase 21 的微信出站图片由 test/wechat-image.mjs 覆盖：multipart 的 mediatype=pic、MediaType=3、webwxsendmsgimg 的 Type=3/MediaId/去重、Outbound 成功与暂停、相对路径图片提取并从文本移除、缺失/非图片回退、围栏代码跳过、outbound=false 保持纯文本；没有用真实微信账号验证实际上传和图片消息。
- Phase 15 的暂停状态卡、手动开关和自动暂停轻提示没有在真实微信账号下走完整链路；弹层只在已登录时显示状态卡，隔离 profile 无法伪造成已登录。
- Phase 14 的近期 worker 记录、scope=recent 候选字段、空窗口和无 lastUsedAt 字段的 lossless 输出由 smoke 覆盖；挑选行为本身是 prompt 约束，未用真实模型验证。
- Phase 13 的设置页已在隔离 DSH 里真实点击：设置导航出现 Ria；开关默认勾选，关闭后显示“当前：已关闭”且 GET /settings 返回 false，重新打开后恢复 true；截图 ui-settings.png。system prompt section 的安装、开关和空文本同时由单元测试与 smoke 覆盖。
- Phase 11 只用 mock 的 agent/status 事件验证，尚未在真实 worker 会话里触发。
- 临时 worker 权限（审批阶段二）已实现，等待用户在真实会话里首次验证。
- 微信文件发送链路已实现并用 mock 覆盖，尚未用真实微信账号完成 .md 收发验证。
- 微信暂停推送的自动切换、队列丢弃和持久化由单元测试与 HTTP smoke 覆盖；没有用真实微信账号验证暂停期间的连接保持。

文件：

- lib/tickets.mjs：ticket 归一化、状态机与 22 条不变量、attention、checklist 归一化/严格解析/合并与进度、依赖校验/评估/就绪纯函数、v1→v4 迁移。
- lib/index.js：Host、RiaStore（含 recentWorkers、dispatchNotes）、12 个工具（含 ria_queue、ria_title）、manager prompt、启动恢复、HTTP API（含 settings、dispatch-notes、只读 board）、模型解析与 selectModel 接线、approval observer 接线、grant 接线、微信服务接线、DispatchGuard 接线。
- lib/dispatch-guard.mjs：agent 作用域静态 system prompt section 的安装、agent/created 与 disposed 监听、开关求值、dispose。
- lib/approvals.mjs：approval/request 只读观察器、pending 列表、TTL/abort/shutdown 清理。
- lib/worker-idle.mjs：agent/status 只读监听、working ticket executor 过滤、Ria 排除、按 worker+task 节流、配置/环境变量归一化。
- lib/outbox.mjs：副作用队列、原子写、幂等 key、退避重试、delivered 清理、失败保留、summary、按谓词作废（依赖退回等待时删除 queue wake）。
- lib/grants.mjs：临时权限 set/list/reset、原值记录、task close/expiry/startup 恢复、审计、失败重试。
- lib/client.js：侧边栏入口、瞬时 launcher、入口右侧微信 chip 和登录弹层（含推送状态卡、暂停/恢复按钮、自动暂停轻提示）、设置页 Ria section、conversation.chat.turnTail 派发 note 卡片、conversation.input.dock 的 blank 欢迎卡片、侧栏 Ria 入口右侧（看板→设置→连接）的任务看板图标与全屏只读看板。
- lib/wechat/wxweb.mjs：文件传输助手协议、扫码登录、文本发送、uploadMedia 单块 multipart 上传、.md 文件 appmsg 发送、图片 sendImage（mediatype=pic、MediaType=3、webwxsendmsgimg Type=3），以及 requestBuffer/downloadImage 原图下载（webwxgetmsgimg，回落文件域名与 webwxgetmedia）。
- lib/wechat/markdown.mjs：长度/代码块/表格/标题/链接判定、配置归一化、文件名。
- lib/wechat/image.mjs：wechatImage.inbound/outbound 归一化（默认都 true）、MsgType 3 识别、<img> 元数据/原文字解析、入站原图校验与 stateDir/wechat-inbound 落盘、30 天/500 个清理、失败文本，以及 imageMediaType 文件头识别。
- lib/wechat/service.mjs：进程内连接、assistant 文本回传、派发 note 文本镜像、长回复转文件/失败回退、出站 Markdown 图片提取与发送、入站去重、入站图片下载/校验/落盘/文本+图片投递与失败降级、Ria 投递、重连积压处理、暂停状态与按通道自动切换。
- lib/wechat/request-ids.mjs：wx_ / host_ requestId 前缀与来源判定。
- lib/wechat/outbound.mjs：串行发送、图片/文件/文本共用队列、暂停门禁、排队丢弃、在途完成。
- cordis.patch.yml：插件 patch。
- test/model.mjs：模型注册表解析（精确/唯一/歧义）、ria_spawn 创建时设置模型与失败语义、ria_model 改 worker/Ria、previous 与 status 投影、session_missing/subagent/归档、未知模型不创建会话。
- test/title.mjs：ria_title 成功改名与 previous、session_missing、subagent 的 not_top_level、归档、宿主 title_invalid 原 message 透传，以及改 Ria 自己。
- test/queue.mjs：ria_queue 的三种 placement 列表、ria_read.queue、itemId/rpcId 撤回与 itemId 优先、找不到/解析失败、session_missing/not_top_level/session_archived、冷会话 queue=null、updateQueue 错误映射。
- test/ticket-queue.mjs：依赖创建/等待不可派、ready 只唤醒一次与 queueToken、缺 token/过期 token、worker_busy（queue 拒绝、steer 放行、空闲放行）、依赖输入校验（自指/重复/缺失/环/上限且不写入）、failed/cancelled 告警与 blocked 不告警、级联取消 deferred、merge 边转移、ria_status queue 输出、ria_resolve dependsOn。
- test/checklist.mjs：v3→v4 迁移与 .v3.bak、创建/追加/显式清勾/replaceAll/drop、check 成功与越界/非布尔/终态/混用拒绝、ria_status 与看板 progress、归档摘要；test/ticket-queue-restart.mjs：v2→v3 迁移与备份、startup 重算、恢复单位排除 waiting 工单、排队摘要合并、未派发 ready 工单补发 boot wake。
- test/board.mjs：GET /board 投影（counts/lanes/queue/dependsOn、dependentCount、archived、self 归 Ria、缺失 worker 进未分配、workspaceRegistry 失败降级）、limit/before 分页与 page 元数据、非法参数 400、归档工单合并，以及路由 JSON 响应。
- test/smoke.mjs：Host 流程 smoke；近期 worker 记录、scope=recent/sessions 字段、空窗口、失败不更新、prompt 规则与 lossless 断言；dispatch-notes 按 session/turn 过滤、错误 session 空列表、note 持久化、snapshot 读取失败仍派发并记录 note；派发 note 的微信镜像调用、失败隔离与 outbox 重试。
- test/attention.mjs：attention 设置/读取/清空、旧 blockedReason 工单、ria_status 输出。
- test/outbox.mjs：outbox 单元与服务集成测试（幂等、退避、失败上限、清理、坏文件、无 turn 排队、补投）。
- test/wechat.mjs：微信服务单元测试，含派发 note 的 task/quick 格式、暂停丢弃、恢复发送、未登录跳过、发送异常，以及图片开关归一化、MsgType 3 识别、默认开启投递与显式关闭提示。
- test/wechat-image.mjs：图片上传/发送字段、去重、Outbound 成功与暂停、本机 Markdown 图片提取、缺失/非图片回退、围栏跳过、outbound=false。
- test/wechat-image-inbound.mjs：入站图片下载（webwxgetmsgimg 失败回落 webwxgetmedia、Cookie/query）、requestBuffer 超限/无 Cookie、落盘与重名、纯图片占位、下载失败/空/超限/未知类型降级、30 天与 500 个清理、宿主附件校验失败与投递失败回退、InboundBridge 投递 text+image。
- test/wechat-file.mjs：Markdown 判定、文件发送、失败回退和 multipart/appmsg 单元测试。
- test/wechat-pause.mjs：手动暂停/恢复、自动按通道切换、合成消息过滤、manual 优先级、队列竞态、丢弃日志、重启持久化。
- test/approvals.mjs：审批观察器单元测试。
- test/grants.mjs：临时权限单元测试（过期、startup、漂移跳过、恢复失败、审计）。
- test/worker-idle.mjs：正常触发、Ria 排除、非 working/running 不触发、节流、关闭开关、多 ticket 合并、配置归一化。
- test/startup.mjs：未收敛 ticket 恢复、forked 递归、恢复上限、blocked 状态、更新/成功派发清零、启动异常通知；另由 test/task-state、test/intake、test/merge、test/archive 覆盖状态机、强制点、合并与归档；test/ticket-queue 与 test/ticket-queue-restart 覆盖依赖与唤醒。
- test/dispatch-guard.mjs：section 安装、agent/created 与 disposed、重复安装、开关文本、失败 warning、shutdown。
- system-dispatch-guard.md：系统级防误发提示调研，含 DSH 注入点、对比、推荐方案和落地步骤；v0.23 已按静态 section + 设置页方案实施。
- operations.md：运行入口、欢迎提示、ticket 生命周期与转述、派发 note 卡片、副作用 outbox、派发提示开关、归档、重启恢复、worker idle 唤醒。
- tools.md：12 个 ria_* 工具参考、ticket checklist、排队消息、ticket 排队与依赖、worker 模型、会话改名、attention、近期 worker、审批可见性和临时权限、manager prompt 约束。
- wechat.md：微信连接、暂停推送、长回复转 .md、出站图片与入站图片（下载协议、落盘、清理、失败降级）。
- state-and-api.md：状态目录文件清单与 HTTP API。
- testing.md：35 个测试套件的覆盖范围与本地隔离验证方式。
- limitations.md：已知限制与安全边界。
- ui-settings.png：隔离 DSH 中“设置 > Ria”开关的真实界面截图。
- ui-dispatch-note.png：隔离 DSH 中 Ria 会话轮次末尾的“任务已派发”卡片截图（note 为手工写入 ria.json 的验证数据）。

已验证：

- 单例 ensure；第二次 ensure 返回 created=false。
- PTC 创建；ria.json 记录 riaPreset=ptc。
- 侧边栏入口点击后打开同一 Session。
- 专用 Workspace 创建并 attach，会话界面显示工作区 Ria，输入框可用。
- GET /health、POST /ensure、GET /state 正常。
- GET /wechat/status 返回 idle；POST /wechat/login 返回 data:image/jpeg 二维码；弹层显示 190×190 二维码。
- 宽侧边栏中 chip 位于 Ria 标题右侧；折叠侧边栏不插入。
- startup 测试覆盖 recoveryCount=3 的 working ticket：启动后产生一条通知、任务变 blocked 并带 blockedReason，status 可见；通知包含 ticketId/executor/goal；更新 task 和成功派发都会把 recoveryCount 清零；pending delivery 重试成功也不会误判为超限；resolveAgent 失败时产生启动失败通知。测试不调用模型。
- smoke 覆盖近期 worker：首次派发前 scope=recent 为空；成功 ticket 派发后出现 1 个候选并带 title/cwd/lastTicketId/lastTicketGoal/lastTicketStatus/lastUsedAt；scope=sessions 带 title 和可选的 cwd/lastUsedAt；失败 request 不更新；ria.json 持久化 recentWorkers；所有工具输出递归检查为 lossless。
- smoke 覆盖 Workspace 挂载、12 个工具注册（含 ria_queue、ria_title）、request 投递、ticket 派发不加前缀、dispatch guard section 同时装到 worker 和 Ria、GET/POST /settings 与 GET /state 的 settings、status、read、memory、持久化，以及新建 Ria 不写任何 session 事件、第二次 ensure 不重复；dispatch-guard 测试覆盖安装、created/disposed、重复安装、开关文本、失败 warning、shutdown；wechat 测试覆盖文本提取、事件过滤、入站去重/回显过滤、失败标记、reconnect skip、状态视图，以及图片开关默认开启、MsgType 3 路由与显式关闭提示；wechat-image 覆盖默认开启的本机图片出站、上传/发送协议、文本回退、围栏示例过滤与 outbound 开关；wechat-image-inbound 覆盖原图下载与 webwxgetmedia 回落、超限/无 Cookie、落盘与重名、纯图片占位、各类失败降级、30 天/500 个清理、宿主校验失败与投递失败回退 text+image；approvals 测试覆盖活跃 executor 过滤、始终 next()、abort/TTL/shutdown 清理和 lossless 输出；grants 测试覆盖授权门槛、原值记录、ticket done 自动恢复、显式 reset、过期、startup、漂移跳过、恢复失败和审计；wechat-file 测试覆盖阈值/代码块/表格/标题/链接、配置/env、文件名、短消息不变、长消息发 .md、失败回退，以及上传和 appmsg 字段；wechat-pause 测试覆盖手动开关与持久化、非微信自动暂停、微信自动恢复、host_/schedule 过滤、manual 不被 channel 覆盖、暂停时不发送、排队丢弃而在途完成、恢复后补发 outbox，以及日志字段。spawn 测试覆盖 create 参数、title 重命名、workspace_missing/preset_not_found/spawn_failed、ria_status scope=sessions 可见且不是 subagent；model 测试覆盖 ria_spawn 带模型、ria_model 改 worker/Ria、previous、未知/歧义模型、归档/subagent/缺失会话、status 模型字段与失败后仍用默认模型；title 测试覆盖成功改名与 previous、session_missing、subagent、归档、宿主 title_invalid 原 message 透传和改 Ria 自己；attachments 测试覆盖图片投递 content、attachment_missing/attachment_invalid/model_no_image、多目标部分成功、失败不投递且不动 ticket；attention 与 outbox 测试覆盖结构化等待项和副作用可靠投递；queue 测试覆盖三种 placement、itemId/rpcId 撤回、冷会话 queue=null 与错误映射。本次 npm test 三十五个 suite 全部通过（含 queue、ticket-queue、ticket-queue-restart、title）；此前历史记录为二十六个测试通过。
- 新建 Ria 后真实 Web UI 在输入框上方显示欢迎卡片（blank 状态），发出第一条消息后消失；没有浏览器 runtime error。修复后的 Ria 会话日志通过 v4 校验（restoreReleasedV4Artifact：VALID，264 个事件），隔离 DSH 重启并重新打开 Ria 不再出现 corrupt。
- 真实 Web UI 中 ticket 派发的 note 渲染在轮次末尾：DOM 有 [data-ria-dispatch-note="ticket"]，标题“任务已派发”，位于轮次末尾；无 runtime error；截图 ui-dispatch-note.png。真实 ria_request 写入路径由 smoke 覆盖。
- 审批观察器没有在真实 UI 中触发过；只做了单元测试和 smoke。首次实际审批时需确认 pending 列表和清理行为。
- 欢迎卡片不在 transcript 里，不计入轮次和步骤，不随历史加载；发出第一条消息后消失。

已知限制：

- 工作区列表会多一个 Ria Workspace。
- 隔离测试 profile 没有配置模型，界面显示“请选择模型”；真实 profile 使用用户当前默认模型。
- 插件已作为 `file:` 依赖安装到真实的 ~/.dsh/profiles/web（`node_modules/dsh-ria` 是拷贝，不是符号链接）；改动 `lib/` 后需要同步该副本并重启 dsh web 才生效。
- Phase 13 的设置页已在隔离 DSH 中实际点击并验证开关与持久化；真实模型是否遵守 section 提示仍未验证。
- 审批可见性阶段不代批；审批动作仍需在 worker 会话里完成。
- 防误发提示依赖 worker 模型遵守；插件无法强制或验证，worker 仍可能直接执行。设置页只开关 section，不改变 worker 的历史、tools 或 preset。
- 临时权限没有在真实会话里触发过；只做了单元测试和 smoke，首次 grant 时需确认 DSH 事件投影和恢复行为。
- sandbox override 无法清除；恢复写回原 effective mode，可能留下同值 override。
- 微信 .md 文件发送只按网页版协议 mock 验证；真实账号的文件上传/下载尚未验证。
- 微信图片双向都只按网页版协议 mock 验证；真实账号的图片上传/下载和 Type=3 消息尚未验证。出站只支持 assistant 文本里的本机图片文件，不支持远程 URL、DSH imagePart 或粘贴图片；入站落盘原图但只接受四种图片格式，上限取 20MB 与宿主附件限制的较小值。
- .md 文件发送失败回退文本时，若文本仍超过 4 块，会按原有文本切块策略截断。
- 恢复上限在启动时判定；如果给 Ria 的通知本身发送失败，只记录日志，任务仍会保持 blocked，等待用户或下次启动处理。
- 微信暂停 UI 只在 chip 弹层已登录时出现；自动暂停提示依赖 2 秒/15 秒轮询，最迟约 15 秒才在侧边栏出现。真实微信账号未验证暂停期间的连接保持。
- 暂停不能撤回已经在发送中的那一条；只保证后续排队消息不发出。
- 近期 worker 只记录 Ria 成功派发过的会话；用户手工使用不计入。挑选是 prompt 约束，Host 不强制，也未用真实模型验证是否符合预期。
