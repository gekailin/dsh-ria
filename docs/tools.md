# 工具与 worker 管理

> **v2 提示：** 插件默认运行 v2，Chatbot / Advisor / Worker 各自只拿到 scoped 的 `chatbot_*`、`ticket_*`、`worker_*` 工具，不再有 15 个 `ria_*`。本文描述的是 legacy manager 模式（`{ v2: false }`），见 [design-v2.md](design-v2.md)。
>
> **v2 提权：** 正常提权走按风险逐条审批（四档规则与工单 `escalationPolicy` 见 [design-v2.md](design-v2.md) §6）；`chatbot_grant` 仅调试/应急，调用写 `grant_kind=debug|emergency` 审计。
>
> **v2 停止：** Chatbot 用 `chatbot_stop_ticket({ticketId, reason})` 强制停止工单：工单转 `cancelled` 并记录 reason、清空 pending steer；DSH 提供 `sessionController.cancel` 时硬中断，否则在 worker 下一个 pre-step 软停止。重复调用幂等，已 done 的票拒绝。参数、事件与语义见 [design-v2.md](design-v2.md) §6 的「强制停止」与「Chatbot 工具清单」。

Ria 通过 run_code SDK 调用 15 个 `ria_*` 工具（含反思编排 `ria_reflect`、文件发送 `ria_send_file` 和主题管理 `ria_topic`）。工具只在 Ria 的 Agent ctx 上注册，worker 侧不需要安装任何东西。

## 工具

| 工具 | 作用 |
|---|---|
| ria_resolve | 给一条 intake 工单定性，每个真实用户消息都要调用一次。kind=answered 以 resolution.kind=answered 关闭问答；kind=work 开正式任务（executor 必填或默认 self，start=true 仅表示本轮自己开始做）；kind=merge 并入 targetTicketId 并在需要时重开；kind=control 对 targetTicketId 执行 cancel/reopen/retry；kind=blocked 挂起并写 blockedReason 与 waitingOn=user/approval/environment，waitingOn=user 时传 attention {kind, question, options?}；kind=work 可带 dependsOn 声明先后。关闭目标工单时若 checklist 仍未完成，同样返回 checklist_pending，需要传 waiver 说明豁免理由。split 属 P1，当前返回 not_supported。只有 intake 可 resolve，重复调用返回 intake_already_resolved；不要用 ria_ticket 改 intake。 |
| ria_ticket | 建/改/关/合并工单。字段：ticketId、goal、acceptance、executor（self 或一个顶层 worker sessionId）、status（intake/open/working/blocked/forked/done/failed/cancelled）、blockedReason、waitingOn、attention、dependsOn、checklist、replaceAll、drop、check({index,done})、cascade、topicId（仅 create）。dependsOn 最多 8 个，不能自指/重复/指向 intake/成环；有未完成依赖时工单停在 open + waitingOn=dependency，不可派发，上游全部 done 后写 readyAt 并给 queueToken。cascade=downstream 仅用于 status=cancelled：取消排队/阻塞/intake 下游，working 下游不打断并作为 deferred 返回。当 status=blocked 且 waitingOn=user 时，attention 用 {kind:'question'|'approval'|'decision', question, options?, askedBy?, ref?} 记录“在等用户回答什么”；旧工单只有 blockedReason 也能正常读取。checklist 是一组有序步骤 {text, done}，最多 50 条、每条 ≤200 字；默认追加并保留未提供项的勾选，同 text 只有显式 done 才改勾，replaceAll=true 整表重建但仍保留同 text 的勾，drop:[index,...] 先按旧索引删除再合并。check:{index,done} 只切换一项，必须单独调用，不能与其它字段同时给；终态工单拒绝。错误码 checklist_invalid / checklist_index。status=done 或 cancelled 时若清单仍有未勾项，host 默认拒绝关闭（code=checklist_pending），返回 `checklistPending={total,done,pendingCount,pending}`（pending 最多 5 条文本），工单状态不变。只有显式传 `waiver`（说明为什么豁免）才放行，并把 waiver、checklistPending、waivedAt、waivedBy 一并写进 `resolution`；没有静默关单路径。一个工单只有一个 executor；状态只能经状态机转移。每次更新都会把 recovery.count 归零。创建时可选 `topicId`：在同一 store 写入里把这张票挂为对应主题的 primary；主题不存在、已归档或已合并则整单拒绝（topic_missing / topic_archived），票不会落库。创建结果与 `ria_status` 单票视图都带 `primaryTopicId`；未挂主题时结果另带一句 `topicMissingHint`，但不阻断。更新已有工单不接受 `topicId`，要改归属用 `ria_topic link`。action=merge 把 sourceTicketId 并进 targetTicketId：依赖边先转移（指向 source 的改为 target，source 的依赖并入尚未开跑的 target），source 以 done + resolution.kind=merged 收敛且 merged done 不算依赖完成，子工单与待投递消息改挂 target，合并不可逆；target 保留自己的 checklist，不继承 source 的清单。 |
| ria_status | 查看工单和可管理的顶层 Session。可带 scope=tickets、scope=sessions、scope=recent 或 scope=history；带 ticketId 可精确查一条（归档的也能查）。scope=tickets 只列热存储（所有非终态 + 最近 24h 或最新 50 条终态）；scope=history 从归档日志按 closedAt 倒序读，默认 50 条、limit 最大 200。scope=sessions 带 title、cwd、updatedAt、lastUsedAt，以及已知的 provider、model、reasoningEffort；scope=recent 返回最近 7 天成功派发过的最多 20 个顶层 worker，按 lastUsedAt 倒序，带 sessionId、title、cwd、lastUsedAt、lastTicketGoal、lastTicketStatus 和同样的模型字段。不会 resume 冷会话。所有工单响应附带 attentionOverview：waitingOnUser、waitingOnApproval、total 计数与 items（ticketId、goal、question、kind、options、askedBy、ref、legacy）。每张工单还带 checklist 与 progress（如 "3/7"，无清单时为空串），以及 queueState（waiting_dependency/ready/dependency_alert/dispatched/blocked/none）、queueText、queueToken、blockedBy、readyAt、readyNotifiedAt、dependencyAlerts；scope=tickets 另外返回 queue {waiting,ready,alerts,items}，items 只含非终态且有 dependsOn 的工单，按 ready→alert→waiting 排序。所有工单响应也附带 outbox：pending、failed、delivered、total 与 items（未投递条目，含 kind、attempts、due、ticketId、lastError、note）；带 ticketId 查询时只统计该工单的条目。 |
| ria_spawn | 新建一个顶层 worker 会话。cwd 必须是存在且可读的绝对目录；agentPreset 可选；title 可选（创建后用 title 服务重命名，失败只返回 titleError，不影响创建）；model、provider、reasoningEffort 可选，用于给新会话选模型。model 在创建前按宿主模型注册表解析，未知或歧义（同名模型属于多个 provider 且未给 provider）会直接返回 model_not_found，不创建会话；创建后 selectModel 失败会返回 ok=false + 已创建的 sessionId，并说明它仍使用默认模型，可用 ria_model 重试。失败码：workspace_missing、preset_not_found、spawn_failed、model_not_found。新会话作为 top-level worker 出现在 ria_status scope=sessions，不会被当成 subagent。 |
| ria_model | 改一个已存在顶层会话（默认 worker；明确要求时也可改 Ria 自己）的模型。只改模型选择，不发消息、不建工单、不唤醒会话。改前按 ria_request 的预检检查会话存在、非 subagent、未归档、cwd 可用，另加 model_not_found。model 必填；模型名在多个 provider 下都存在时必须显式给 provider。成功返回 selected {provider, model, reasoningEffort?} 与已知的 previous；ria_status scope=sessions/recent 会立即反映新模型。 |
| ria_title | 改一个已存在顶层会话（含 Ria 自己，不含 subagent）的会话名。只改名，不发消息、不建工单、不唤醒 worker、不改其它状态。预检同 ria_model（存在、非 subagent、未归档、cwd 可用）；空标题或宿主判定标题非法返回 title_invalid，宿主原始 message 原样附回。成功返回 {ok:true, sessionId, title} 与已知的 previous。 |
| ria_request | 把工单的消息发给一个或多个 worker。ticketId 与 note 均必填；mode=queue 或 steer；content 支持 text/image/file；attachments 支持最多 20 个图片绝对路径（png/jpeg/webp/gif），与 content 一起作为 text + image parts 投递，交给宿主 attachment 服务统一校验和存储。目标 executor 必须等于 ticket.executor。Host 先把 note 和微信镜像写入副作用 outbox，有活跃 turn 时立即记录到 ria.json，由插件 client 在 Ria 会话当前轮次末尾显示成可见卡片，不进入模型上下文；没有活跃 turn 时留待下一次 turn/start、startup 或 30 秒 tick 补投。同时把 note 作为“📌 任务已派发：<note>”推送到微信；发送失败由 outbox 退避重试，不阻断派发。缺 note、空白或超长会直接报错且不投递。附件预检失败码：attachment_missing、attachment_invalid、model_no_image；预检失败不投递、不写 recentWorkers、不动工单。Host 不加消息前缀；防误发提示由 agent system prompt section 提供。mode=queue 时若目标正在跑 turn 或已有非空 pending 队列，直接返回 worker_busy 且不投递；依赖工单必须带当前 queueToken，未就绪、token 缺失/过期或已派发都返回 ticket_not_ready。mode=steer 仍可插进运行中的 turn，但只用于同步信息，不得用来下发新任务。 |
| ria_topic | 管理看板主题与工单归属。action=create/update/link/unlink/merge/archive/list/suggest。主题字段 topicId、title、level（1/2）、parentId、brief；suggest 需要 goal，可选 limit（默认 5，1–20），返回活跃主题与未挂 primary 的热票候选，只读；工单经 links 关联，role=primary 或 related，一个工单最多一个 primary（再设 primary 会自动把旧 primary 降为 related）。merge 把源主题的链接改指目标并标 mergedInto；archive 只在该主题没有未完成工单时允许，否则返回 topic_unfinished。只维护主题，不派发、不唤醒 worker、不改工单状态。 |
| ria_send_file | 把本机一个文件发到最近活跃的手机通道（微信 Claw、QQ 或微信「文件传输助手」）。path 必须是绝对路径，realpath 解析后须是普通文件、非空、扩展名在 allowlist 内且不超过通道上限；note 可选、最多 500 字。通道暂停时 durable 排队并返回 queued=true；没有回复目标返回 no_target；成功或失败都记 lastFileSend。只发文件，不建工单、不唤醒 worker、不改任务状态。 |
| ria_read | 读某个 Session 的近期消息。live 用 snapshotEvents，冷会话用持久化 events，不 resume。返回值还带 queue：与 ria_queue list 相同的 pending 视图，冷会话为 null。 |
| ria_queue | 列出或撤回一个顶层 worker 尚未执行的消息。action=list 返回 running 与 queue（id、placement=queued/steering/context、可选 rpcId、preview）；冷会话 queue=null。action=remove 接受 itemId 或 rpcId（rpcId 来自 ria_request 的 requestId；两者都给时 itemId 优先），不可恢复，只删 pending，不停止当前 turn、不改工单、不影响 recentWorkers。失败码 queue_item_not_found、queue_remove_failed；预检同 ria_request。 |
| ria_approval | 列出正在等待 Ria 裁决的 worker 审批（仅限有 active 工单的 executor）。每项带 approvalId、workerSessionId、ticketId、toolName、callId/reason、risk、argsPreview、decisionBy、createdAt、expiresAt、expiresInMs。低风险已被宿主规则直接放行，不会出现在列表里。只读：不批准、不拒绝。 |
| ria_approval_decision | 裁决一条待批请求。decision=allow 只放行本次调用（allowed-once）；deny 拒绝；ask-user 交给用户原生审批 UI。只有 low/medium 可 allow，high 只接受 ask-user/deny（否则 code=risk_requires_user）。必须 2 分钟内决定，否则宿主按拒绝处理并通知用户；每次决定写 audit.jsonl。不能用来放宽 sandbox/approval policy，那只能由用户明确要求后走 ria_grant。 |
| ria_grant | 调整一个顶层会话的 sandbox mode 和/或 approval policy。action=set/list/reset；set 必须带 userConfirmed=true。纯降权永久生效，只有 reset 才恢复；任何提权必须带 TTL，并在任务结束、到期或重启时恢复。 |
| ria_memory | 读/写 memory.md 与归档记忆。core 预算默认 2400 字符 / 12 条 / 单条 300 字符，按 Unicode code point 计；超限拒绝写入；archive 按主题存 `memory-archive/<slug>.md`，不注入 prompt。 |

## 记忆预算与归档（ria_memory）

- core 在 `stateDir/memory.md`，全局一份，0600；默认预算 **2400 字符 / 12 条 / 单条 300 字符**，按 Unicode code point 计。超限拒绝写入且不部分写入，90% 时只给 warning。完整口径、错误格式与迁移状态见 [memory-budget.md](memory-budget.md)。
- `action=read` 读 core（`scope=archive` 加 `path`/`offset` 读归档）、`remember`/`forget` 增删条目、`replace` 整体重写（`content` 或 `entries` 二选一，超限整次拒绝）、`list` 列归档。
- archive 在 `stateDir/memory-archive/<slug>.md`，单文件软上限 16 KB，默认每次读 4000 字符；**不注入 system prompt**。
- 设置页只暴露条目数（1–50）；`POST /settings` 仍接受三项预算，下一轮生效。

## 工单排队与依赖

工单的先后顺序用 `dependsOn` 表达，不复用 `ria_queue`（后者管理单个 worker 还没执行的消息）。创建或更新工单时给 `dependsOn: ["ticket_a", ...]`：只要有一个上游没到 `done`，工单就保持 `open + waitingOn=dependency`，不能 `ria_request`。上游全部 done 后 host 写 `readyAt`、算出 `queueToken = ticketId:readyAt:revision`，并通过 outbox 的 `queue_wake` 叫醒 Ria；`ria_request` 必须带当前 `queueToken`，同一次就绪最多派发一次（工单已 working、退回等待或 revision 变了都返回 `ticket_not_ready`）。就绪通知以已提交的 `readyAt` / `readyNotifiedAt` 为准：写入提交、启动和 Ria turn 结束都会从状态补发缺失的 `queue_wake`，不依赖单次事件回调。

上游 `failed`/`cancelled` 不自动跳过：下游留在 `open/dependency`，写 `dependencyAlerts`，并发 `[Queue blocked]` 让 Ria 报告用户；上游 `blocked` 只是继续等，不告警。`dependsOn` 最多 8 个，可跨 root、可指向已归档的 done 工单；自指、重复、缺失、指向 intake、成环或超限都会整次拒绝写入（`dependency_invalid/duplicate/limit/self/missing/intake/cycle`）。

`ria_status` 里用 `queueState` 与 `queueText` 看排队状态，例如：

~~~json
{
  "ticketId": "ticket_b",
  "goal": "补回归测试",
  "status": "open",
  "queueState": "waiting_dependency",
  "queueText": "排队中：等 修完登录接口",
  "blockedBy": [
    { "ticketId": "ticket_a", "goal": "修完登录接口", "status": "working", "executor": "session_x", "archived": false }
  ],
  "readyAt": null
}
~~~

派发顺序：Ria 收到 `[Queue ready]` 后按 `ria_request` 正常派发；**不要给正在跑 turn 或已有排队消息的 worker 用 mode=queue 追加任务**，host 会返回 `worker_busy`。需要表达先后就再加 `dependsOn`，需要用信息插播才用 mode=steer。级联取消用 `ria_ticket({ticketId, status:'cancelled', cascade:'downstream'})`，只取消排队/阻塞/intake 下游，working 下游作为 deferred 返回。

## 工单 checklist

多步或长程工作在建工单时用 `checklist` 写清具体步骤，例如 `checklist: ['复现问题', '改解析器', '补回归测试']`。每完成一步调用 `ria_ticket({ ticketId, check: { index, done: true } })`；索引从 0 开始，输入越界返回 `checklist_index`。更新时默认是追加：老条目原位保留、勾选保留，新条目排在末尾；重复传同一条没有 `done` 不会清掉原有勾选，要清勾必须显式 `{ text, done: false }`。要整体重写就传 `replaceAll: true`，同 text 的条目仍保留旧勾，除非显式给了 `done`；要删旧条目就用 `drop: [index, ...]`，索引按更新前的列表计算。

`ria_status` 的单工单、`scope=tickets` 每项与看板卡片都带 `progress`（`已完成/总数`），看板只多这一行文本，不改布局。归档摘要 `tickets.log.jsonl` 的 `checklist` 记录 `{ total, done, pending }`，`pending` 最多列 5 条未勾项文本。终态工单的清单视为最终结果，`check` 返回 `checklist_invalid`；要改先 reopen 或新建工单。

工单以 `status=done` 或 `status=cancelled` 收敛时，如果清单还有未勾项，host 默认拒绝：返回 code=`checklist_pending` 与 `checklistPending={total,done,pendingCount,pending}`，`pending` 最多 5 条文本，工单保持原状态。要豁免必须显式传 `waiver`（任意非空字符串，说明为什么这些步骤可以不做），放行后 `resolution` 会同时记录 `waiver`、`checklistPending`、`waivedAt`、`waivedBy`，后续查 `ria_status` 或归档仍能看到。创建即 done/cancelled、merge 源单、级联取消、`ria_resolve` 收口走同一门禁；父工单自动收口时由 host 写入系统 waiver，保证关闭原因有记录而不是静默放行。合并工单不继承源工单的 checklist：目标保留自己原有的清单，源清单只留在源工单的历史里。

## 主题与看板（ria_topic）

看板按「项目 → 主题 → 工单」组织。项目直接复用现有 workspace（以及 Ria、未分配、路径回退），主题是项目内的一级分组；工单通过 links 挂到一个或多个主题，卡片只统计 `role=primary` 的归属，related 只在主题页出现。没有 primary 的工单进入所属项目即时合成的「未分类」桶，不写进 `ria.json`。

`ria_topic` 的 action：

- `create`：title 必填，可带 brief、level（1/2，默认 1）、parentId。
- `update`：改 title、brief、level 或 parentId；parentId 不能指向自己或成环，已归档/已合并主题拒绝。
- `link`：topicId + ticketId，role 默认 primary；一票最多一个 primary，再设会旧 primary 自动降为 related；工单不存在返回 `ticket_missing`。
- `unlink`：只删链接，不影响工单。
- `merge`：sourceTopicId + targetTopicId，把源主题链接改指目标并写 mergedInto + archivedAt；同票已有链接时合并为一条并保留最新 primary。
- `archive`：仅当主题下所有工单都终态时允许；否则 `topic_unfinished`，message 列出前几个 ticketId。
- `list`：默认隐藏归档/合并主题，`includeArchived=true` 全返回；每项带 counts（total/open/working/blocked/done）。
- `suggest`：见下。

主题卡 summary 优先用手写 `brief`；为空时取该主题 `updatedAt` 最新的 primary 工单，生成「「goal 最多 60 字」状态词 · 待执行 N · 执行中 M · 已完成 K」，为 0 的段省略；未分类桶显示「N 张待分类 · 最近：「goal」」，空桶「暂无工单」。返回的 `brief` 是最终展示文本，`summaryAuto` 区分人工/自动。Ria 在派发、收口或标 blocked 后若主题进展句变化，用 `update` 写最多 120 字符；没变、10 分钟内写过或工单无主题时不写。

### 自动归主题（suggest）

`ria_topic({ action: "suggest", goal, limit? })` 只读，goal 必填，limit 默认 5、范围 1–20。范围是本 Ria 的活跃主题（排除 archived/merged），候选文本为主题 title + brief + 已链接工单的 goal；`tickets` 则是热存里没有 active primary 的工单。评分确定、不依赖模型：文本先 NFKC + 小写，汉字连续串取相邻 2-gram，拉丁/数字取整 token，空白标点忽略；`score = 2 * 交集权重 / (查询权重 + 候选权重)`，保留 4 位，`score>0` 才返回，按 score 降序、同分按 topicId/ticketId 稳定排序。它不建主题、不 link 工单、不改历史归属。

创建工单时可直接带 `topicId` 原子挂 primary；未挂的创建结果带 `topicMissingHint`，只是提示不阻断。Ria 的固定流程：每张新 work 工单创建后、派发前先 suggest，相近就 link primary；没有相近就立即 create（title 概括方向 ≤40 字，brief 一句话）再 link；后续票优先复用，方向变化用 update/merge；存量票不回溯，除非用户明确要求。

主题与链接存 `ria.json` 的 `topics`、`links`（schema v5）；旧 v4 文件原样加载，首次写入前备份 `ria.json.v4.bak`。看板的布局、筛选、搜索与「说」入口细节见 [board-preview.md](board-preview.md)。

## 排队消息（ria_queue）

`ria_queue` 管理一个顶层 worker 尚未执行的消息。`action=list` 返回 running 和 queue：`queued` 是下一轮才执行的消息，`steering` 是插进当前轮的插播，`context` 是其它非用户上下文；每项带 id、placement、可选的 rpcId 和约 120 字 preview。冷会话没有内存队列，queue 为 null。`action=remove` 接受 itemId 或 rpcId（都给时 itemId 优先）；rpcId 就是 `ria_request` 返回的 requestId，是 Ria 找回排队消息的唯一句柄。撤回不可恢复，只删除仍 pending 的条目：不停止当前 turn、不改工单、不影响 recentWorkers。目标预检与 `ria_request` 一致，Ria 自己和 subagent 会被拒绝；找不到条目返回 `queue_item_not_found`，宿主其它失败返回 `queue_remove_failed`。`ria_read` 的返回值也带同一份 queue。

## Worker 模型

Ria 通过宿主模型注册表（`ctx.get('llm').listProviders()/listModels(provider)`）解析 `model`，不猜 provider：只给模型名时，它必须在所有 provider 中唯一；同名模型存在于多个 provider 时必须显式传 `provider`，否则返回 `model_not_found` 并列出可选路由。解析成功后调用 `sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })`，由宿主校验并持久化。

- 新建 worker：`ria_spawn` 的 `model`/`provider`/`reasoningEffort`。模型在创建前解析，未知模型不会留下会话；创建后选模型失败会返回 `ok:false` + `sessionId`，明确说明该会话仍用默认模型。
- 已有 worker：`ria_model({ sessionId, model, provider?, reasoningEffort? })`。预检与 `ria_request` 一致（存在、top-level、未归档、cwd 可用），允许显式改 Ria 自己，但默认面向 worker。
- 状态：`ria_status` 的 session/recent 条目从会话的 `modelSelection` 投影读取 `provider`、`model`、`reasoningEffort`（未知时省略），不需要唤醒冷会话。

## 会话改名

`ria_title({ sessionId, title })` 只改会话名，适合用户说“把那个 worker 改名叫……”或给 Ria 自己换名字。它走宿主 `sessionController.rename`，不会发消息、不会创建或修改工单、不会唤醒冷会话，也不改模型、权限等其它状态；新建 worker 时仍用 `ria_spawn` 的 `title`。

预检与 `ria_model` 相同：会话必须存在、是顶层会话（subagent 一律拒绝）、未归档、cwd 仍可用，失败码为 `session_missing`、`not_top_level`、`session_archived`、`workspace_missing`，且失败不产生任何副作用。标题只包含空白或不可见字符时返回 `title_invalid`；宿主返回 `session/title-invalid` 时同样映射成 `title_invalid`，并带上宿主的原始 message。成功返回 `{ ok: true, sessionId, title }`；能从会话投影读到旧标题时附 `previous`，读不到就省略。允许改 Ria 自己，因为用户在设置里也能看到并修改自己的会话名。

## 说话风格

设置页的「说话风格」是默认关闭的总开关，只影响 Ria 写给用户的自然语言，不改变工具调用、术语和必报项。配置存在 ria.json 的 settings.style：`enabled`、`preset`（concise 简洁 / warm 温和 / formal 严谨 / playful 轻松）、`custom`（最多 300 字）。没有单独的 default 档；关闭就是现在的默认行为。

开启后，Host 在 manager prompt 的 `## Identity` 之后、`## User memory` 之前插入 `## Voice`：所选预设的行为描述、同一内容的正面/反面示例、三条固定边界（只作用于自然语言；不改变工具/术语/必报项/note ≤500 字/安全规则；内容契约优先），以及非空 custom 的最后覆盖要求。关闭时整段不注入，prompt 与未引入该功能时逐字节一致。`GET /settings` 的 `style.effectiveText` 返回 Host 实际渲染的完整文本，关闭时为空字符串；前端不复制文案，只显示开关、预设和输入框。

## 等待用户拍板（attention）

`blocked + waitingOn=user` 的工单可以带 `attention`，把“在等什么问题、有哪些选项、什么时候问的”结构化存进 ria.json。`ria_status` 的任意工单响应都会返回 `attentionOverview`：`waitingOnUser`/`waitingOnApproval` 分别是等用户与等审批的工单数，`items` 逐条给出问题；只有老 `blockedReason` 的历史工单仍然可读，并标 `legacy=true`。工单离开 blocked、关闭或被 reopen 时会清空 attention。

`attention` 和 `ria_approval` 是两件事：`ria_approval` 只读地列出 **worker** 正在等待的审批，审批由 worker 会话和 UI answerer 处理；`attention` 是 **Ria 自己**需要用户拍板的问题（方案选择、是否继续、范围确认等），不会批准或拒绝任何 worker 操作。

## 近期 worker 与默认选择

用户派任务但没有指定 worker 时，manager prompt 要求 Ria 只从“近期用过”的顶层 worker 里选，不遍历全部会话，也不凭空挑一个没用过的。规则由 Host 的字段支撑，不把完整会话列表塞进 prompt。

- **近期用过的定义**：Host 成功接受过一次 ria_request 的顶层 worker；只创建或更新工单不算。
- 时间窗口 7 天，最多返回 20 个，按 lastUsedAt 倒序。记录保存在 ria.json 的 recentWorkers，只保留最近 30 天，避免无限增长。
- ria_status 的 scope=recent 返回 sessionId、title、cwd、lastUsedAt、lastTicketId、lastTicketGoal、lastTicketStatus，以及 running/blank；缺失字段直接省略，保证输出是 lossless JSON。
- scope=sessions 也带 title 和 lastUsedAt，方便用户明确点名某个会话时核对；但默认挑选只要求看 scope=recent。
- 近期列表为空、没有一个明显合适、或 Ria 自己判断不清时，先问用户选哪个会话，不猜，也不退回“遍历全部会话”。
- title 来自 DSH 的 title projection；没有标题、没有 cwd 或不是近期用过的 worker，对应字段不输出。

## 审批自动化与可见性

- 插件在根上下文监听 `approval/request`。开启 `approvalAutomation`（默认）时，先用 `tools/pre-execute` 缓存的参数按 `lib/approval-policy.mjs` 分类：低风险直接返回 `allowed-once`；硬拒绝直接返回 `rejected`；中/高风险进入 Ria 裁决。
- 中/高风险会立刻把对应工单从 open/working 迁到 `blocked` + `waitingOn=approval`，写入 `attention={kind:'approval', question, askedBy:'worker', ref:approvalId}`；`blockedReason` 是同一句中文问题。这样 `ria_status` 的 `attentionOverview.waitingOnApproval` 与 items 能直接看到卡在哪。
- 同时经 outbox 排两条可见副作用：`approval_note` 卡片（在 Ria 当前 turn 末尾显示，没有活跃 turn 时等下一次 turn/start）和 `wechat_approval_note` 微信提醒（`🔐 等待权限审批：...`）。两条都用 `approvalId` 做 dedupeKey；后续 allow/deny/timeout 结果用 `approvalId:event` 另发一条。
- Ria 通过 `source.kind=ria-approval` 的 `agent.followup` 消息被唤醒，不经过 `sessionController.prompt`，所以不会污染 intake 或手机渠道的人类消息锚点。消息里带工单目标/验收、工具、风险、脱敏参数和 2 分钟 TTL。
- `ria_approval_decision` 在 TTL 内回填：allow → `allowed-once`，deny → `rejected`，ask-user → 调用原生 UI 的 `next()` 并以用户结果收尾。超时、唤醒失败、审计写入失败 → `rejected` 并通知用户。每次决定都写 `stateDir/audit.jsonl` 的 `approval/decision`。
- 审批结束（允许/拒绝/取消）、AbortSignal abort 或 TTL 到期时，工单走 `blocked -> open -> working`，`waitingOn=worker` 并清空 attention。同一工单有多个 pending 审批时，等最后一个结束再恢复。
- 审批队列只在内存里。startup 会把「blocked+waitingOn=approval 但 ref 已不在 pending」的工单恢复为 working，避免重启后永久卡住。
- 关闭 `approvalAutomation` 后回退旧行为：只记录、block、通知，然后 `next()` 交给原生 UI，15 分钟 TTL；Ria 不能代批。`ria_approval` 返回当前 pending 列表及每项的 `ticketId`、`risk`、`argsPreview`、`expiresAt`、`expiresInMs`。
- 用户要批准/拒绝时，仍需打开对应 worker 会话操作；Ria 只能转告是哪个 worker、哪个工具、什么原因，不能代替用户决定。

## 会话权限（阶段二）

当用户明确要求调整某个顶层会话的权限时，Ria 才调用 `ria_grant`。它不是自动提权，也不会因为 worker 被审批卡住就自行放宽。

- `set` 必须由用户明确指令触发，且传 `userConfirmed=true`；Host 不提供任何自动 set 路径。
- 作用在任意顶层会话上（直管 worker、独立会话、Advisor）；Ria/Chatbot 自己不可调整。至少指定 `sandboxMode` 或 `approvalPolicy`，可以关联一个未关闭的工单。
- 支持 `sandboxMode=read-only|workspace-write|danger-full-access` 和 `approvalPolicy=ask|never`。`never` 是自动拒绝需要审批的操作，不是自动允许。
- **纯降权永久**：不设过期时间，工单结束或重启都不会恢复，只有显式 `reset` 才恢复原值。
- **任何提权临时**：sandbox 等级变大，或 approval 从 `ask` 变成 `never`，都算提权；必须有 TTL，默认 30 分钟，可设 60 秒到 24 小时。关联工单时，在工单 done/cancelled、到期或 DSH 下次启动时恢复；同时包含降权和提权的混合变更按提权处理。
- 同一会话同时只保留一个 grant。
- Host 记录生效值和 override 原值，写入 `ria.json` 和 `audit.jsonl`；恢复是保守的：如果用户期间手工改过该字段，当前值已不等于 grant 写入的值，就跳过该字段并在结果里报告，不覆盖用户的新选择。
- 恢复失败会标记 `restore_failed`，60 秒后重试；审计里能看到失败原因。
- 不改会话的 tools、prompt 或 preset。

## 发送文件

`ria_send_file` 只负责把本机一个文件发到用户手机上的聊天通道，不建工单、不派发、不唤醒 worker、不改任务状态。入站文件的落盘与投递见 [wechat.md](wechat.md#文件) 和 [channels.md](channels.md#文件)。

参数：

- `path`：必填，绝对路径。工具先做 `realpath`，再按解析后的真实路径检查，符号链接只要最终指向普通文件就发送。
- `note`：可选，最多 500 字。文件发送成功后，会以 `📎 <note>` 作为一条普通文本随后发出（微信 Claw/QQ/文件传输助手都走各自的 sendNote）；说明发送失败只写 `noteError`，不影响文件已送达。

校验顺序与错误码：

| 错误码 | 条件 |
|---|---|
| `path_required` | `path` 缺失或空 |
| `path_not_absolute` | 不是绝对路径 |
| `file_not_found` | `realpath` 或 `stat` 失败 |
| `file_not_regular` | 解析后不是普通文件（目录、设备、管道等） |
| `file_empty` | 大小为 0 |
| `file_unsupported` | 扩展名不在 allowlist；message 会列出允许的类型 |
| `no_target` | 三个通道都没有可回复目标 |
| `file_send_disabled` | 选中通道的 `channels.<id>.files.enabled=false` |
| `file_too_large` | 超过该通道 `maxBytes` |
| `file_read_failed` | 读取文件失败 |
| `file_queue_failed` | 暂停时写 outbox 失败 |
| `file_send_failed` | 通道发送失败；返回值带 `lastFileSend` 与通道原始错误 |

扩展名 allowlist：pdf、doc/docx、xls/xlsx、ppt/pptx、zip/gz/tar/7z/rar、txt、md、csv、json、html、xml、yml/yaml、log、png/jpg/jpeg/gif/webp、svg。

通道与上限：

- 候选是微信 Claw、QQ 机器人、微信「文件传输助手」；按各通道最近一次入站消息的 `lastInboundAt` 降序选第一个有可回复目标的通道，时间相同时按上面的顺序。没有在任一通道给 Ria 发过消息时返回 `no_target`，不会广播到多个通道。
- 每个通道的上限默认 20 MB，可用 `channels.<id>.files.maxBytes` 调整；微信 Claw 的入站上限同类配置上限为 100 MB。
- 微信 Claw 出站：`getuploadurl`（`media_type=3`）→ CDN AES-128-ECB 密文 → `sendmessage` 的 `type=4 file_item`；AES key 编码和字段见 [channels.md](channels.md#文件)。
- QQ 机器人出站：官方 SDK 的 `sendFile`，使用最近入站消息的 C2C/群聊回复目标。
- 微信「文件传输助手」出站：网页版 `sendFile` 的 appmsg 文件消息。

暂停与重试：

- 选中通道暂停时，不读文件进内存、不调 CDN，直接把 `{channel,path,name,bytes,note}` 作为 `channel_file_send` 写进 outbox，返回 `{ok:true,queued:true,channel,name,bytes,path,entryId,message}`；恢复推送后自动发送。
- 投递时通道未连接或没有 peer 返回 `{deferred:true}`，不消耗 `attempts`；暂停同理。超过 24 小时仍未连上时会抛错并进入 outbox 的失败退避，不会无限挂着。
- 暂停、没有目标、排队成功都不算已送达。模型不能对用户说“已发送”，只能按返回的 `queued=true` 说已排队、恢复后发送。
- 成功和失败都写通道状态里的 `lastFileSend`：成功 `{at,delivered:true,name,bytes,path}`；失败再加 `code`、`error`，微信 Claw 另有 `ret`、`errmsg`。`GET /channels/<id>/status` 和 `/api/state` 可见。

边界：只发本机文件，不接受 URL 或 base64；一次只发一个文件；图片仍可用 `ria_request` 的 `attachments` 转给 worker，但那是给 worker 的附件，不是发给用户手机。

## 管理者 prompt 的行为约束

Ria 的系统 prompt 要求：每条真实用户消息都要用 `ria_resolve` 给出归宿（answered/work/merge/split/control/blocked），不能让它悄悄消失；需求不明确时先和用户澄清，再下发；不要凭猜测开工；任务要有验收标准；进度按需查询；经验按 case 集总结（需求、错误做法、正确做法），默认只在对话里输出，用户指定路径时才写文件；重启后先 read 再决定是否继续；收到 `[Worker idle]` 时先 read，确认完成才关工单，等用户输入就标 blocked；worker 明确拒绝任务或用户取消/叫停 worker turn 时，标 blocked 并停下来问用户下一步，不自行改派、重发或换方案；防误发提示由 agent system prompt section 提供，任务消息本身不加前缀；派发必须提供 note（一两句话：派给谁、做什么、用户接下来看到什么），Host 会把它显示成 Ria 会话当前轮次末尾的卡片，并同步一条微信文本；缺 note 或空白会直接报错、不投递，也不会结束本轮；成功派发后立即结束本轮，不再 sleep/poll；不给忙碌 worker（有运行中的 turn 或非空 pending 队列）用 queue 模式排队，先后顺序用 dependsOn 表达，steer 只用于同步信息、绝不下发新任务；上游 failed/cancelled 的 [Queue blocked] 要先报告用户再决定，不自行跳过或改写需求；用户要求换 worker 模型时用 ria_model，新建 worker 要指定模型时用 ria_spawn 的 model 参数；只有用户明确要求时才使用 ria_grant，绝不自行放宽 worker 权限；用户没指定 worker 时只从 scope=recent 的近期 worker 里挑，近期没有合适的就先问用户，不遍历全部会话、不凭空挑。

## 反思编排工具（仅 Ria）

ria_reflect 是反思的编排入口，只注册给 Ria。它管理 `reflections/` 下的 run、锁和状态文件，不读取长日志，也不创建 worker。

- `action=status`：返回 {state, run, schedule, settings}。run 是当前 active run 或 state.lastRunId 的摘要；settings 是真实的 settings.reflection（enabled/cadence/time/weekday/model/provider/reasoningEffort）加 implemented:true 与 scheduleAvailable；schedule 为 {id, available, error}，宿主没有 schedule 服务时 error 说明原因。
- `action=begin`：参数 forDate?、trigger（manual|schedule，默认 manual）、force?，以及可选的 model/provider/reasoningEffort。默认 forDate 为 Asia/Shanghai 今天；计算左闭右开窗口；做三重幂等（state.lastCompletedDate、`.lock` 的 O_CREAT|O_EXCL、`runs/<runId>/run.json`）。同日已 complete 且非 force 返回 skipped:"completed"；已有 live run 返回 locked:true。成功返回 {runId, forDate, ordinal, title, window, reportPath, plannedReportPath, instruction, spawn, attempt, locked:false}，**不创建 worker**。这里两个路径字段都是**计划路径**（同日重跑会预先指向 `<forDate>.manual-HHMM.md`），对外只引用 finish 返回的 reportPath。标题为 `反思 YYYY-MM-DD`（YYYY-MM-DD 为 forDate，Asia/Shanghai 口径）；同日第 2 次及以后为 `反思 YYYY-MM-DD（第N次）`，N 从 2 起，手动触发同样适用。本 turn 的 intake 只在 goal/origin/acceptance 命中反思词或 forDate 时绑定到 `run.intakeTicketId`，不再用“唯一 intake”兜底。spawn 建议 `agentPreset=minimal`、`reflectionRunId=runId`、cwd=stateDir，标题直接用返回的 title。settings.reflection 里配置的 model/provider/reasoningEffort 优先于本次传入的同名字段，用于固定反思 worker 的模型。
- `action=dispatch`：参数 runId、sessionId。只接受刚绑定到该 run 的 starting worker；用 `sessionController.prompt` 以 `mode=queue` 发 instruction，写 workerSessionId/dispatchedAt/deadlineAt=+15min 并把 run 置为 running。dispatch 会同时在固定主题 `topic_mwiuz6a8_mf0u06`（记忆与反思）下建一张监控工单：goal 为 `反思 <forDate> 运行监控`、executor 为该反思 worker、status=working，并记到 run.json 的 watchTicketId；重复 dispatch 不会重复建单。prompt 抛错时把 run 标 failed、释放锁、把监控单标 blocked 并返回 dispatch_failed 与 attempts。
- `action=validate`：参数 runId、status（complete|partial）、markdown。只跑与 finish 相同的报告校验（front matter、必需章节、迭代建议上限 5 条、200 行/30KB），返回 {ok,problems,...}，不写任何文件；worker 可先验后写。
- `action=finish`：参数 runId、status（complete|partial）、counts?、degraded?。读取 worker 写的 `runs/<runId>/report.partial.md`，校验 front matter（schema=2、runId、status、date、timezone、window、trigger、attempt、workerSessionId、计数、degraded）和八个固定标题；可选「对 dsh-ria 的迭代建议」存在时要求非空且最多 5 条（按编号条目计数，兼容 `**1. …**` 写法；没有编号时按空行分隔的顶格 bullet 组计数，一条建议的多个 bullet 只算一条）；memory 候选的 `[target: global|worker:<sessionId>]` 缺省为 global，非法 target 降级 global 并把 warning 放进返回值和 run.json。非法或缺失返回 report_invalid/report_missing 并把 run 标 failed、释放锁。合法时由宿主用 run 的 `dispatchedAt/createdAt` 与 `run.stats` 覆盖 front matter 的 durationMs、compressedBytesRead、decompressedBytesRead（模型写的值不采信），再原子写正式报告（complete → `reflections/<forDate>.md`，partial → `reflections/<forDate>.partial.md`；目标已存在时改写到 `reflections/<forDate>.manual-HHMM.md`，不覆盖），返回值里的 reportPath 是最终落盘路径，也是对外唯一权威路径，再写 state.json、删匹配锁、解绑 worker。只有 complete 推进 lastCompletedDate；finish 同时把监控单置为 done，resolution 写入 reportPath、bytes、status、runId 与 warnings。finish 只关闭 begin 绑定的 `run.intakeTicketId`；票不存在返回 intake_missing warning，目标与反思不相关返回 intake_unrelated warning 且不关闭。
- `action=abort`：参数 runId、reason、cancelled?。标记 cancelled/aborted，释放匹配的锁，把监控单置为 cancelled 并写 resolution，不产生正式报告；其他失败结束（report_invalid、超时、abandoned）把监控单置为 blocked + waitingOn=user，写 blockedReason 与 failure。

锁的 TTL 为 20 分钟，但过期不等于可抢：worker 仍 running 时仍返回 locked；worker 不存在或已 idle 且没有 partial 报告时才接管，旧 run 标 abandoned。自动重试最多 1 次：同 forDate 的第一次失败后，Ria 可再次 begin 得到 attempt=2；第二次失败后 begin 返回 skipped:"failed"，需用户决定。没有新增后台 timer，deadline 只在 status/begin 等已有事件里评估。反思 worker 创建后只保留 6 个只读 `ria_reflect_*` 工具：绑定安装完成后调用 `agent.ctx.tools.restrict({allow: []})` 移除全部全局工具（真实宿主实测可见工具恰好 6 个，无 shell/写文件/网络/MCP）。

## 反思读取工具（仅反思 worker）

反思 worker 由编排层用 `ria_spawn({reflectionRunId})` 创建；创建前必须先打开 run 并写入绑定，绑定命中时只给这个 worker 注册下面 6 个工具。Ria 自己的 15 个 `ria_*` 工具、普通 worker 的会话都看不到这些工具；普通 worker 调它们会得到 unknown_tool。它们全部只读，不会 resume 冷会话，也不会写 `ria.json` 或会话日志。

- `ria_reflect_status`：当前 run 的 runId、forDate、ordinal、title、window、deadline/remainingMs、候选会话、limits、memoryChars、reportPath/draftPath（都是本次 run 的草稿 `runs/<runId>/report.partial.md`，不是正式报告）、state。默认 `scope=candidates` 只列**本 run 窗口内有事件**的会话（最多 50 条）；`scope=all` 返回不按窗口过滤的全部候选。两者都给 `candidateTotal`（run 候选总数，含被窗口过滤掉的）与 `candidatesTruncated`（列表是否撞到 50 条上限）；不再是全部顶层会话的静态名单。
- `ria_reflect_read_tickets`：scope=window/open/history，可按 status/executor 过滤；limit 1–200，默认 80。默认 `detail=summary`，每条只返回 ticketId/goal/status/waitingOn/executor/updatedAt（goal 截 500 字）；`detail=full` 才给 acceptance、blockedReason、attention、resolution、failure、dependsOn、checklist、progress 等完整字段。`scope=open` 只返回非终态工单，done/cancelled/failed 不会混进来。
- `ria_reflect_read_sessions`：scope=candidates（默认，只含窗口内有活动的候选）/recent（最近 7 天派发过的 worker）/all（不按窗口过滤的全部候选）；limit 1–50，默认 50；返回 `{scope,sessions,total,truncated}`，只含 sessionId/title/running/blank/lastUsedAt/ticketIds 等元数据。candidates/all 的 `total` 是候选总数（含无活动的），recent 的 `total` 是命中 7 天窗口的 worker 数；`truncated` 表示是否被 limit 截断。
- `ria_reflect_read_session`：mode=summary（默认）或 full；summary 保留 user、每 turn 最后一条 assistant、tool/thinking brief；full 返回原始事件，必须给 refs 或 from/to。refs 1–50 且只能用于本会话之前返回过的 ref；from/to 同为 ISO 时间或同为事件下标，左闭右开；maxMessages 默认 50/20，maxChars 默认 10000/40000；坏帧跳过并计入 corruptFrames。summary 可加 `tailTurns`（1–50）：按 turn 从最近往回取，返回仍按时间升序；不能与 refs/from/to 同用，full 模式不支持；没有 turn 信息时回退为最后 N 个事件。
- `ria_reflect_read_context`：kind=memory/outbox/schedule；memory 最多 4096 字符，outbox 最多 50 条，schedule 本轮返回空视图。
- `ria_reflect_report`：只写 `runs/<runId>/report.partial.md`，原子写、0600、不超过 30KB；不接受 path/runId/sessionId 参数。写入前先跑与 finish 相同的校验，失败返回结构化错误（code + problems），不落盘、旧文件保持不变。run finish/abort 后所有工具返回 run_closed。

一次真实日志试跑的量级、缺口和默认值建议见 [archive/reflection-and-review.md](archive/reflection-and-review.md)。

## v2 工具补充：经验库（lessons）

v2 的 Advisor / Worker 额外有经验闭环工具（legacy 模式没有）：

- `worker_report.lessons`：Worker 报告可带 ≤5 条候选 `{scenario, pitfall, approach, evidence?}`。候选落在 v2.json 的候选区，**不自动生效**；done 报告会提示候选条数。reflection Worker 在复盘票里用同一字段提炼经验。
- `lesson_search`（Advisor 只读）：参数 `query`、`workspace`、`mode`、`limit`（1–5，默认 3）。走内存倒排索引，返回 `{lessons:[{id,scenario,pitfall,approach,tags,source,hits}], total, scanned}`，不扫全库。
- `lesson_review`（Advisor）：`action=list|accept|reject`，`id`（accept/reject 必填），`status`（list 过滤，默认 candidate）。accept 按「scenario + pitfall」归一查重：命中则合并 tags/来源、保留最新 approach、hits 相加并返回 `deduped:true`；未命中新建并返回 `deduped:false` 与 `entryId`。reject 只标记候选，不入库。
- `ticket_plan.lessons`：可选 lesson id 列表，写进 WorkOrder 的 `lessons`（id + 短场景）。派发时这些条目的 `[Lessons]` 段进入 Worker brief；未钉时按工单 goal/workspace/mode 自动匹配 ≤3 条，总长 ≤800 字符。

经验库文件：`DSH_HOME/state/ria/lessons.json`（0600，原子写，≤500 条）。条目含 id/场景/适用条件/正文/来源(ticket+session)/时间/命中数；派单用到的 id 记在 ticket meta 的 `usedLessons` 和派发返回体里，可追溯。
