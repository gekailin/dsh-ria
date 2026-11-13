# 工具与 worker 管理

Ria 通过 run_code SDK 调用 12 个 `ria_*` 工具。工具只在 Ria 的 Agent ctx 上注册，worker 侧不需要安装任何东西。

## 工具

| 工具 | 作用 |
|---|---|
| ria_resolve | 给一条 intake 工单定性，每个真实用户消息都要调用一次。kind=answered 以 resolution.kind=answered 关闭问答；kind=work 开正式任务（executor 必填或默认 self，start=true 仅表示本轮自己开始做）；kind=merge 并入 targetTicketId 并在需要时重开；kind=control 对 targetTicketId 执行 cancel/reopen/retry；kind=blocked 挂起并写 blockedReason 与 waitingOn=user/approval/environment，waitingOn=user 时传 attention {kind, question, options?}；kind=work 可带 dependsOn 声明先后。split 属 P1，当前返回 not_supported。只有 intake 可 resolve，重复调用返回 intake_already_resolved；不要用 ria_ticket 改 intake。 |
| ria_ticket | 建/改/关/合并工单。字段：ticketId、goal、acceptance、executor（self 或一个顶层 worker sessionId）、status（intake/open/working/blocked/forked/done/failed/cancelled）、blockedReason、waitingOn、attention、dependsOn、checklist、replaceAll、drop、check({index,done})、cascade。dependsOn 最多 8 个，不能自指/重复/指向 intake/成环；有未完成依赖时工单停在 open + waitingOn=dependency，不可派发，上游全部 done 后写 readyAt 并给 queueToken。cascade=downstream 仅用于 status=cancelled：取消排队/阻塞/intake 下游，working 下游不打断并作为 deferred 返回。当 status=blocked 且 waitingOn=user 时，attention 用 {kind:'question'|'approval'|'decision', question, options?, askedBy?, ref?} 记录“在等用户回答什么”；旧工单只有 blockedReason 也能正常读取。checklist 是一组有序步骤 {text, done}，最多 50 条、每条 ≤200 字；默认追加并保留未提供项的勾选，同 text 只有显式 done 才改勾，replaceAll=true 整表重建但仍保留同 text 的勾，drop:[index,...] 先按旧索引删除再合并。check:{index,done} 只切换一项，必须单独调用，不能与其它字段同时给；终态工单拒绝。错误码 checklist_invalid / checklist_index。一个工单只有一个 executor；状态只能经状态机转移。每次更新都会把 recovery.count 归零。action=merge 把 sourceTicketId 并进 targetTicketId：依赖边先转移（指向 source 的改为 target，source 的依赖并入尚未开跑的 target），source 以 done + resolution.kind=merged 收敛且 merged done 不算依赖完成，子工单与待投递消息改挂 target，合并不可逆。 |
| ria_status | 查看工单和可管理的顶层 Session。可带 scope=tickets、scope=sessions、scope=recent 或 scope=history；带 ticketId 可精确查一条（归档的也能查）。scope=tickets 只列热存储（所有非终态 + 最近 24h 或最新 50 条终态）；scope=history 从归档日志按 closedAt 倒序读，默认 50 条、limit 最大 200。scope=sessions 带 title、cwd、updatedAt、lastUsedAt，以及已知的 provider、model、reasoningEffort；scope=recent 返回最近 7 天成功派发过的最多 20 个顶层 worker，按 lastUsedAt 倒序，带 sessionId、title、cwd、lastUsedAt、lastTicketGoal、lastTicketStatus 和同样的模型字段。不会 resume 冷会话。所有工单响应附带 attentionOverview：waitingOnUser、waitingOnApproval、total 计数与 items（ticketId、goal、question、kind、options、askedBy、ref、legacy）。每张工单还带 checklist 与 progress（如 "3/7"，无清单时为空串），以及 queueState（waiting_dependency/ready/dependency_alert/dispatched/blocked/none）、queueText、queueToken、blockedBy、readyAt、readyNotifiedAt、dependencyAlerts；scope=tickets 另外返回 queue {waiting,ready,alerts,items}，items 只含非终态且有 dependsOn 的工单，按 ready→alert→waiting 排序。所有工单响应也附带 outbox：pending、failed、delivered、total 与 items（未投递条目，含 kind、attempts、due、ticketId、lastError、note）；带 ticketId 查询时只统计该工单的条目。 |
| ria_spawn | 新建一个顶层 worker 会话。cwd 必须是存在且可读的绝对目录；agentPreset 可选；title 可选（创建后用 title 服务重命名，失败只返回 titleError，不影响创建）；model、provider、reasoningEffort 可选，用于给新会话选模型。model 在创建前按宿主模型注册表解析，未知或歧义（同名模型属于多个 provider 且未给 provider）会直接返回 model_not_found，不创建会话；创建后 selectModel 失败会返回 ok=false + 已创建的 sessionId，并说明它仍使用默认模型，可用 ria_model 重试。失败码：workspace_missing、preset_not_found、spawn_failed、model_not_found。新会话作为 top-level worker 出现在 ria_status scope=sessions，不会被当成 subagent。 |
| ria_model | 改一个已存在顶层会话（默认 worker；明确要求时也可改 Ria 自己）的模型。只改模型选择，不发消息、不建工单、不唤醒会话。改前按 ria_request 的预检检查会话存在、非 subagent、未归档、cwd 可用，另加 model_not_found。model 必填；模型名在多个 provider 下都存在时必须显式给 provider。成功返回 selected {provider, model, reasoningEffort?} 与已知的 previous；ria_status scope=sessions/recent 会立即反映新模型。 |
| ria_title | 改一个已存在顶层会话（含 Ria 自己，不含 subagent）的会话名。只改名，不发消息、不建工单、不唤醒 worker、不改其它状态。预检同 ria_model（存在、非 subagent、未归档、cwd 可用）；空标题或宿主判定标题非法返回 title_invalid，宿主原始 message 原样附回。成功返回 {ok:true, sessionId, title} 与已知的 previous。 |
| ria_request | 把工单的消息发给一个或多个 worker。ticketId 与 note 均必填；mode=queue 或 steer；content 支持 text/image/file；attachments 支持最多 20 个图片绝对路径（png/jpeg/webp/gif），与 content 一起作为 text + image parts 投递，交给宿主 attachment 服务统一校验和存储。目标 executor 必须等于 ticket.executor。Host 先把 note 和微信镜像写入副作用 outbox，有活跃 turn 时立即记录到 ria.json，由插件 client 在 Ria 会话当前轮次末尾显示成可见卡片，不进入模型上下文；没有活跃 turn 时留待下一次 turn/start、startup 或 30 秒 tick 补投。同时把 note 作为“📌 任务已派发：<note>”推送到微信；发送失败由 outbox 退避重试，不阻断派发。缺 note、空白或超长会直接报错且不投递。附件预检失败码：attachment_missing、attachment_invalid、model_no_image；预检失败不投递、不写 recentWorkers、不动工单。Host 不加消息前缀；防误发提示由 agent system prompt section 提供。mode=queue 时若目标正在跑 turn 或已有非空 pending 队列，直接返回 worker_busy 且不投递；依赖工单必须带当前 queueToken，未就绪、token 缺失/过期或已派发都返回 ticket_not_ready。mode=steer 仍可插进运行中的 turn，但只用于同步信息，不得用来下发新任务。 |
| ria_read | 读某个 Session 的近期消息。live 用 snapshotEvents，冷会话用持久化 events，不 resume。返回值还带 queue：与 ria_queue list 相同的 pending 视图，冷会话为 null。 |
| ria_queue | 列出或撤回一个顶层 worker 尚未执行的消息。action=list 返回 running 与 queue（id、placement=queued/steering/context、可选 rpcId、preview）；冷会话 queue=null。action=remove 接受 itemId 或 rpcId（rpcId 来自 ria_request 的 requestId；两者都给时 itemId 优先），不可恢复，只删 pending，不停止当前 turn、不改工单、不影响 recentWorkers。失败码 queue_item_not_found、queue_remove_failed；预检同 ria_request。 |
| ria_approval | 列出正在等待审批的 worker（仅限有 active 工单的 executor）。每项带 approvalId、workerSessionId、ticketId、toolName、callId/reason、createdAt、expiresAt、expiresInMs。捕获审批时会把对应工单标成 blocked+waitingOn=approval、写 kind=approval 的 attention，并排一张 approval_note 卡片与一条微信提醒。只读：不批准、不拒绝、不替 UI answerer 作答。 |
| ria_grant | 临时调整一个 worker 的 sandbox mode 和/或 approval policy。action=set/list/reset；set 必须带 userConfirmed=true，并记录原值、到期时间、审计，任务结束或 reset 时恢复。 |
| ria_memory | read/remember/forget。写 stateDir/memory.md，0600，上限 4096 字节。 |

## 工单排队与依赖

工单的先后顺序用 `dependsOn` 表达，不复用 `ria_queue`（后者管理单个 worker 还没执行的消息）。创建或更新工单时给 `dependsOn: ["ticket_a", ...]`：只要有一个上游没到 `done`，工单就保持 `open + waitingOn=dependency`，不能 `ria_request`。上游全部 done 后 host 写 `readyAt`、算出 `queueToken = ticketId:readyAt:revision`，并通过 outbox 的 `queue_wake` 叫醒 Ria；`ria_request` 必须带当前 `queueToken`，同一次就绪最多派发一次（工单已 working、退回等待或 revision 变了都返回 `ticket_not_ready`）。

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

## 审批可见性

- 插件在根上下文监听 `approval/request`，只记录有 open/working 工单的 executor 的待审批请求：worker session、工单、工具、callId、原因、时间。
- 捕获时立刻把对应工单从 open/working 迁到 `blocked` + `waitingOn=approval`，写入 `attention={kind:'approval', question, askedBy:'worker', ref:approvalId}`；`blockedReason` 是同一句中文问题。这样 `ria_status` 的 `attentionOverview.waitingOnApproval` 与 items 能直接看到卡在哪。
- 同时经 outbox 排两条可见副作用：`approval_note` 卡片（在 Ria 当前 turn 末尾显示，没有活跃 turn 时等下一次 turn/start）和 `wechat_approval_note` 微信提醒（`🔐 等待权限审批：...`）。两条都用 `approvalId` 做 dedupeKey。
- 记录后立即调用 `next()`，把决定权交回原有 UI answerer；插件从不改变审批结果。
- 审批结束（允许/拒绝/取消）、AbortSignal abort 或 15 分钟 TTL 到期时，工单走 `blocked -> open -> working`，`waitingOn=worker` 并清空 attention。同一工单有多个 pending 审批时，等最后一个结束再恢复。
- 审批队列只在内存里。startup 会把「blocked+waitingOn=approval 但 ref 已不在 pending」的工单恢复为 working，避免重启后永久卡住。
- `ria_approval` 返回当前 pending 列表及每项的 `ticketId`、`expiresAt`、`expiresInMs`（剩余毫秒）；pending 在审批结束、abort、15 分钟超时或 DSH 重启后清除。
- 用户要批准/拒绝时，仍需打开对应 worker 会话操作；Ria 只能转告是哪个 worker、哪个工具、什么原因，不能代替用户决定。

## 临时 worker 权限（阶段二）

当用户明确要求“临时放开某个 worker”时，Ria 才调用 `ria_grant`。它不是自动提权，也不会因为 worker 被审批卡住就自行放宽。

- `set` 必须由用户明确指令触发，且传 `userConfirmed=true`；Host 不提供任何自动 set 路径。
- 只作用在一个顶层 worker 上，至少指定 `sandboxMode` 或 `approvalPolicy`，可以关联一个未关闭的工单。
- 支持 `sandboxMode=read-only|workspace-write|danger-full-access` 和 `approvalPolicy=ask|never`。`never` 是自动拒绝需要审批的操作，不是自动允许。
- 默认 30 分钟过期，可设 60 秒到 24 小时；同一 worker 同时只保留一个 grant。
- Host 记录生效值和 override 原值，写入 `ria.json` 和 `audit.jsonl`；在工单 done/cancelled、显式 reset、到期或 DSH 下次启动时恢复。
- 恢复是保守的：如果用户期间手工改过该字段，当前值已不等于 grant 写入的值，就跳过该字段并在结果里报告，不覆盖用户的新选择。
- 恢复失败会标记 `restore_failed`，60 秒后重试；审计里能看到失败原因。
- 不改 worker 的 tools、prompt 或 preset。

## 管理者 prompt 的行为约束

Ria 的系统 prompt 要求：每条真实用户消息都要用 `ria_resolve` 给出归宿（answered/work/merge/split/control/blocked），不能让它悄悄消失；需求不明确时先和用户澄清，再下发；不要凭猜测开工；任务要有验收标准；进度按需查询；经验按 case 集总结（需求、错误做法、正确做法），默认只在对话里输出，用户指定路径时才写文件；重启后先 read 再决定是否继续；收到 `[Worker idle]` 时先 read，确认完成才关工单，等用户输入就标 blocked；worker 明确拒绝任务或用户取消/叫停 worker turn 时，标 blocked 并停下来问用户下一步，不自行改派、重发或换方案；防误发提示由 agent system prompt section 提供，任务消息本身不加前缀；派发必须提供 note（一两句话：派给谁、做什么、用户接下来看到什么），Host 会把它显示成 Ria 会话当前轮次末尾的卡片，并同步一条微信文本；缺 note 或空白会直接报错、不投递，也不会结束本轮；成功派发后立即结束本轮，不再 sleep/poll；不给忙碌 worker（有运行中的 turn 或非空 pending 队列）用 queue 模式排队，先后顺序用 dependsOn 表达，steer 只用于同步信息、绝不下发新任务；上游 failed/cancelled 的 [Queue blocked] 要先报告用户再决定，不自行跳过或改写需求；用户要求换 worker 模型时用 ria_model，新建 worker 要指定模型时用 ria_spawn 的 model 参数；只有用户明确要求时才使用 ria_grant，绝不自行放宽 worker 权限；用户没指定 worker 时只从 scope=recent 的近期 worker 里挑，近期没有合适的就先问用户，不遍历全部会话、不凭空挑。

## 反思读取工具（仅反思 worker）

反思 worker 由编排层用 `ria_spawn({reflectionRunId})` 创建；创建前必须先打开 run 并写入绑定，绑定命中时只给这个 worker 注册下面 6 个工具。Ria 自己的 12 个 `ria_*` 工具、普通 worker 的会话都看不到这些工具；普通 worker 调它们会得到 unknown_tool。它们全部只读，不会 resume 冷会话，也不会写 `ria.json` 或会话日志。

- `ria_reflect_status`：当前 run 的 runId、forDate、window、deadline/remainingMs、候选会话、limits、memoryBytes、reportPath、state。
- `ria_reflect_read_tickets`：scope=window/open/history，可按 status/executor 过滤；limit 1–200，默认 80；每条 goal/acceptance/blockedReason/checklist 截到 500 字。
- `ria_reflect_read_sessions`：scope=candidates/recent，limit 1–20；只返回 sessionId/title/running/blank/lastUsedAt/ticketIds 等元数据。
- `ria_reflect_read_session`：mode=summary（默认）或 full；summary 保留 user、每 turn 最后一条 assistant、tool/thinking brief；full 返回原始事件，必须给 refs 或 from/to。refs 1–50 且只能用于本会话之前返回过的 ref；from/to 同为 ISO 时间或同为事件下标，左闭右开；maxMessages 默认 50/40，maxChars 默认 10000/30000；坏帧跳过并计入 corruptFrames。
- `ria_reflect_read_context`：kind=memory/outbox/schedule；memory 最多 4KB，outbox 最多 50 条，schedule 本轮返回空视图。
- `ria_reflect_report`：只写 `runs/<runId>/report.partial.md`，原子写、0600、不超过 30KB；不接受 path/runId/sessionId 参数。run finish/abort 后所有工具返回 run_closed。

一次真实日志试跑的量级、缺口和默认值建议见 [reflection_tool_trial.md](reflection_tool_trial.md)。
