# dsh-ria

![阿汐站在玻璃中庭里，手里提着一盏灯](docs/hero.jpg)

**阿汐 · Ria** —— 潮起潮落，事事有着落。  
*Tide may roam — every wave comes home.*

一个 DSH Web 插件：全局只有一个 Ria。她不直接承担实现工作，而是管理用户已有的顶层 Session：转述需求、跟踪进度、总结经验并分发。

Ria 自己是一个普通的顶层 DSH Session，运行 PTC preset，带管理者 prompt 和 10 个 ria_* 工具。worker 侧不需要安装任何东西，收到的就是普通用户消息；防误发提示由 agent 作用域的 system prompt section 提供，不修改消息内容。

![Ria 入口打开后的会话界面](docs/ui-final.png)

## 名字

<img src="docs/ria-avatar.png" width="120" align="right" alt="阿汐的头像">

**阿汐**，英文 **Ria**（西班牙语 *ría*，潮汐河口）。潮水有去有回；她做的事也一样：把事送出海，再把结果带回来。

> 潮起潮落，事事有着落。

文档和消息里，🌊 是她的签名，也是微信出站消息的标记；日志、状态文件和代码里不用 emoji。

## 当前状态

- Phase 0–24 已实现：单例、PTC 创建、任务模型 P0（split 属于 P1、当前返回 not_supported；用户消息自动登记 intake、8 态状态机、ria_resolve 定性、合并、归档、重启恢复）、转述、读取、memory、重启恢复（task 与 Ria 自己未完成 turn 都能续上，含恢复上限可见性）、侧边栏入口、进程内微信和入口右侧的微信 chip、worker 审批可见性、new-session 欢迎卡片、系统 prompt 防误发提示与设置页开关、临时 worker 权限调整、微信长回复/复杂 Markdown 自动转 .md 文件，worker 结束 turn 后自动唤醒 Ria，微信推送的暂停/恢复，以及暂停状态和手动开关的 UI，带 ticketId 派发的 note 硬约束与可见的 turn-tail 派发卡片、同步到微信的派发确认文本，以及对已持久化条目提供至少一次投递与失败可见性的 outbox；blocked+waitingOn=user 的 ticket 可带结构化 attention；微信出站图片已实现（assistant 回复里的本机图片会作为微信图片发出），入站图片仍预留；Ria 可为新建或已有 worker 选择/切换模型（失败码 model_not_found），ria_status 会显示当前模型。
- 已验证环境：DSH 0.2.2-rc.1，Node 26，真实 Web profile 的隔离副本。
- 微信入站目前只投递文本（入站图片仍预留）；出站可发文本、.md 文件与本机图片，见“图片（出站）”。扫码登录需要在弹层里完成一次，之后 DSH 重启会自动复用凭据。

## 安装

在项目目录执行：

~~~bash
dsh plugin --profile web add file:/home/gkl/Desktop/vibe_proj/dsh-ria
~~~

然后重启 dsh web，让 Host 和 client bundle 重新加载。

如果 pnpm 的全局 store 不在可写范围，可以进入 profile 目录手动安装：

~~~bash
cd ~/.dsh/profiles/web
pnpm add --ignore-scripts file:/home/gkl/Desktop/vibe_proj/dsh-ria
~~~

开发时也可以不改 profile，直接用 patch 叠加：

~~~bash
DSH_HOME=$PWD/.verify-home dsh --profile riatest --patch ./cordis.patch.yml --port 3099 --host 127.0.0.1 --no-open
~~~

## 使用

左侧边栏出现 Ria 入口。第一次点击会 ensure：创建全局唯一的 Ria，并把界面切到她；之后点击只是重新打开同一个 Session。

Ria 的 cwd 固定在：

~~~text
DSH_HOME/state/ria
~~~

DSH 的正常会话界面要求 Session 属于一个 Workspace。插件会为该目录创建一个标题为 Ria 的专用 Workspace，并把 Ria 挂进去。因此工作区列表里会多一个名为 Ria 的条目，这是输入框可用的必要条件，不是可选的 UI 装饰。

Ria 运行 PTC 模式：模型直接看到 run_code 和生成的 SDK，10 个 ria_* 工具通过 SDK 调用。创建时固定 agentPreset=ptc；如果 ptc preset/runtime 不可用，会明确报错，不会退回 standard。

## 欢迎提示

新建 Ria 后第一次打开（会话还没有任何 turn）时，输入框上方会显示一张欢迎卡片：提示先选模型、设置权限（建议 danger-full-access + 审批策略），然后直接说想做什么。

- 卡片由 client 插件渲染（`conversation.input.dock`，id=ria-welcome），只在当前会话等于 Ria 且处于 blank 状态时出现；发出第一条消息后自动消失，已存在或重启后的 Ria 不会重复。
- 不写 session 日志：不占 turn、不占用户消息位、不调用模型，也不进入模型上下文。
- 早期实现是在 Host 侧通过 Session.append 写一个合成的 assistant turn。该 turn 排在真实 turn 的 system/message 之前，会让 DSH session-format v4 校验失败（`system/message requires a protected first surface head`），重启后加载历史报 corrupt，因此改为纯 client 卡片。

## 微信

Ria 入口标题右侧有一个“微信”chip。点开后可以扫码登录微信「文件传输助手」网页版、查看连接状态和退出登录。

![微信连接弹层](docs/ui-wechat.png)

- 微信客户端运行在 DSH 进程内，不启动 bridge 进程，不占端口。
- 凭据和去重/待发状态在 `DSH_HOME/state/ria/wechat/`，文件权限 0600。
- 微信发来的文本原样作为普通用户消息进入 Ria，不加前缀，也不直接进 worker。
- Ria 的每条 assistant 文本回复都会同步回微信，统一以 🌊 前缀标记；暂停推送时除外。
- 带 note 的派发/转述成功后，note 也会作为一条普通微信文本推送（见下文“派发 note 卡片”），同样受暂停开关约束。
- 入站只投递文本（入站图片仍预留）；出站支持文本、.md 文件与本机图片：assistant 回复里的 Markdown 图片若指向本机存在的图片文件，会作为微信图片发出，见“图片（出站）”。
- 出站长回复或复杂 Markdown 时，默认改发完整的 .md 文件；短消息和简单文本保持原样。
- DSH 重启后如有 creds 会自动重连；待发文本超过 10 条时只补发最后 10 条，并先提示跳过了多少条。
- chip 只在宽侧边栏显示；折叠侧边栏不插入。

### 暂停推送

暂停只关闭“Ria -> 微信”的出站推送：连接、登录态、长轮询和心跳保持，微信入站照常投递给 Ria。状态存在 `wechat/state.json`，DSH 重启后保持。

- 面板：已登录时 chip 弹层里有一张推送状态卡。正常显示“推送中”；暂停显示“已暂停推送”、来源（“手动”或“自动（非微信通道消息）”）和暂停时间，旁边是“暂停推送 / 恢复推送”按钮。点击后立即用 POST 的返回值刷新，不等下一次轮询。
- 自动暂停提示：弹层轮询或侧边栏轮询发现 paused 从 false 变为 true 且 pausedBy=channel 时，显示一条 8 秒自动消失的轻提示“已自动暂停推送：检测到非微信通道消息”，不弹窗、不打断输入。chip 圆点同时变橙色。
- 手动：`POST /plugins/dsh-ria/api/wechat/pause`，body 为 `{"paused":true}` 或 `{"paused":false}`，可选 `reason`；`paused` 不是布尔值返回 400。
- 查询：`GET /wechat/status` 返回 `paused`、`pausedBy`、`pauseReason`、`pausedAt`、`resumedAt`、`resumedBy`。
- 自动：Web/手机等非微信用户消息进入 Ria 时自动暂停（`pausedBy=channel`）；微信入站自动恢复，包括恢复手动暂停。
- 合成消息（`host_` 开头的启动恢复、启动失败、worker idle 唤醒）和官方 schedule 提醒不触发切换。
- 手动暂停优先：非微信消息的自动暂停不会覆盖 `pausedBy=manual`；手动恢复后，下一条非微信消息会再次暂停，这是预期行为。
- 正在发送的那一条会发完；还没开始发送的排队文本/文件丢弃。暂停期间不写微信内部 Outbound 队列，恢复后按重连积压策略补发。
- 丢弃会记 warn 日志：`dropped outbound while paused: {"at":...,"riaSessionId":...,"to":"filehelper","kind":"assistant|system|text|file","pausedBy":...,"reason":...}`，文本带 chars/preview，文件带 name/bytes。暂停和恢复各有一条 `pause:` / `resume:` info/warn 日志。

### 长回复转 .md 文件

每条 assistant 文本回复都会先过规则；命中任意一项就发 .md 文件，否则直接发文本：

| 命中条件 | 默认值 |
|---|---|
| 字符数 | 超过 800 |
| 代码块 | 有围栏代码块（三个反引号或三个波浪线） |
| 表格 | 有 Markdown 表格 |
| 标题 | 4 个及以上 Markdown 标题 |
| 链接 | 6 个及以上 Markdown 链接 |

文件名形如 `ria-<会话短 id>-YYYYMMDD-HHmmss.md`，内容是完整回复，不截断。命中后先发一条短提示“（内容较长，已转为 Markdown 文件发送）”，再发文件，不重复正文；上传或发送文件失败时，回退为文本，并在正文前加“（原回复已转为 Markdown 文件，但文件发送失败，以下改为文本）”。

配置写在 profile 的 `cordis.yml` 里，覆盖插件行：

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

也可以直接写 `markdownFile: false` 关闭整套规则。环境变量优先级高于 profile 配置：`DSH_RIA_MD_FILE`、`DSH_RIA_MD_THRESHOLD`、`DSH_RIA_MD_CODE`、`DSH_RIA_MD_TABLE`、`DSH_RIA_MD_HEADINGS`、`DSH_RIA_MD_LINKS`。阈值会被限制在安全范围（80–100000 字符）。

### 图片（出站已实现，入站预留）

出站图片默认开启，入站图片仍默认关闭：

~~~yaml
- id: ria
  config:
    wechatImage:
      inbound: false
      outbound: true
~~~

- 触发：Ria 的 assistant 文本里出现 `![alt](path)`，且 path 指向本机真实存在的图片文件时，该图片会作为微信图片发出；不扫描围栏代码块里的示例。
- 路径：绝对路径，或相对 Ria 状态目录（`DSH_HOME/state/ria`）与 dsh 进程当前目录；`file://` 等带 scheme 的地址不处理。
- 类型和大小：按文件头识别 PNG、JPEG、GIF、WebP，大小上限 20 MB；文件不存在、不是图片或超过上限时保留原 Markdown 文本，整条回复照常发送，不会失败。
- 顺序与失败：先发文本（图片语法从文本里去掉），再逐张发图片。某张图片发送失败只记 warn，不影响已经发出的文本和其他图片；暂停推送时按普通出站规则丢弃。
- 协议：与 .md 文件共用同一条串行限速队列；上传用 `mediatype=pic`、`MediaType=3`，发送用 `webwxsendmsgimg` 的 `Msg.Type=3`，返回的 MsgID 加入去重集合。`Outbound.enqueueImage()` 仍接受 `{ name, buffer, mime, ref }`，失败会 reject，调用方可重试。
- 入站：`InboundBridge` 能识别 MsgType 3，但 `imagePartFromMessage` 仍是预留签名（解析 `<img>`、下载原图、转 DSH 图片内容块）；当前明确报 “reserved but not implemented”，不会投递半成品。
- `outbound: false` 时保留原来的纯文本行为；文本、.md 文件、暂停、去重和 outbox 路径不受影响。

## 工具

| 工具 | 作用 |
|---|---|
| ria_ticket | 建/改/关/合并 ticket。字段：ticketId、goal、acceptance、executor（self 或一个顶层 worker sessionId）、status（intake/open/working/blocked/forked/done/failed/cancelled）、blockedReason、waitingOn、attention。当 status=blocked 且 waitingOn=user 时，attention 用 {kind:'question'|'approval'|'decision', question, options?, askedBy?, ref?} 记录“在等用户回答什么”；旧票只有 blockedReason 也能正常读取。一个 ticket 只有一个 executor；状态只能经状态机转移。每次更新都会把 recovery.count 归零。action=merge 把 sourceTicketId 并进 targetTicketId：source 以 done + resolution.kind=merged 收敛，子 ticket 与待投递消息改挂 target，合并不可逆。 |
| ria_status | 查看 ticket 和可管理的顶层 Session。可带 scope=tickets、scope=sessions、scope=recent 或 scope=history；带 ticketId 可精确查一条（归档的也能查）。scope=tickets 只列热存储（所有非终态 + 最近 24h 或最新 50 条终态）；scope=history 从归档日志按 closedAt 倒序读，默认 50 条、limit 最大 200。scope=sessions 带 title、cwd、updatedAt、lastUsedAt，以及已知的 provider、model、reasoningEffort；scope=recent 返回最近 7 天成功派发过的最多 5 个顶层 worker，按 lastUsedAt 倒序，带 sessionId、title、cwd、lastUsedAt、lastTicketGoal、lastTicketStatus 和同样的模型字段。不会 resume 冷会话。所有 ticket 响应附带 attentionOverview：waitingOnUser 计数与 items（ticketId、goal、question、kind、options、legacy）。所有 ticket 响应也附带 outbox：pending、failed、delivered、total 与 items（未投递条目，含 kind、attempts、due、ticketId、lastError、note）；带 ticketId 查询时只统计该票的条目。 |
| ria_spawn | 新建一个顶层 worker 会话。cwd 必须是存在且可读的绝对目录；agentPreset 可选；title 可选（创建后用 title 服务重命名，失败只返回 titleError，不影响创建）；model、provider、reasoningEffort 可选，用于给新会话选模型。model 在创建前按宿主模型注册表解析，未知或歧义（同名模型属于多个 provider 且未给 provider）会直接返回 model_not_found，不创建会话；创建后 selectModel 失败会返回 ok=false + 已创建的 sessionId，并说明它仍使用默认模型，可用 ria_model 重试。失败码：workspace_missing、preset_not_found、spawn_failed、model_not_found。新会话作为 top-level worker 出现在 ria_status scope=sessions，不会被当成 subagent。 |
| ria_model | 改一个已存在顶层会话（默认 worker；明确要求时也可改 Ria 自己）的模型。只改模型选择，不发消息、不建 ticket、不唤醒会话。改前按 ria_request 的预检检查会话存在、非 subagent、未归档、cwd 可用，另加 model_not_found。model 必填；模型名在多个 provider 下都存在时必须显式给 provider。成功返回 selected {provider, model, reasoningEffort?} 与已知的 previous；ria_status scope=sessions/recent 会立即反映新模型。 |
| ria_request | 把 ticket 的消息发给一个或多个 worker。ticketId 与 note 均必填；mode=queue 或 steer；content 支持 text/image/file；attachments 支持最多 20 个图片绝对路径（png/jpeg/webp/gif），与 content 一起作为 text + image parts 投递，交给宿主 attachment 服务统一校验和存储。目标 executor 必须等于 ticket.executor。Host 先把 note 和微信镜像写入副作用 outbox，有活跃 turn 时立即记录到 ria.json，由插件 client 在 Ria 会话当前轮次末尾显示成可见卡片，不进入模型上下文；没有活跃 turn 时留待下一次 turn/start、startup 或 30 秒 tick 补投。同时把 note 作为“📌 任务已派发：<note>”推送到微信；发送失败由 outbox 退避重试，不阻断派发。缺 note、空白或超长会直接报错且不投递。附件预检失败码：attachment_missing、attachment_invalid、model_no_image；预检失败不投递、不写 recentWorkers、不动 ticket。Host 不加消息前缀；防误发提示由 agent system prompt section 提供。 |
| ria_read | 读某个 Session 的近期消息。live 用 snapshotEvents，冷会话用持久化 events，不 resume。 |
| ria_approval | 列出正在等待审批的 worker（仅限有 active ticket 的 executor）。只读：不批准、不拒绝、不替 UI answerer 作答。 |
| ria_grant | 临时调整一个 worker 的 sandbox mode 和/或 approval policy。action=set/list/reset；set 必须带 userConfirmed=true，并记录原值、到期时间、审计，任务结束或 reset 时恢复。 |
| ria_memory | read/remember/forget。写 stateDir/memory.md，0600，上限 4096 字节。 |

### Worker 模型

Ria 通过宿主模型注册表（`ctx.get('llm').listProviders()/listModels(provider)`）解析 `model`，不猜 provider：只给模型名时，它必须在所有 provider 中唯一；同名模型存在于多个 provider 时必须显式传 `provider`，否则返回 `model_not_found` 并列出可选路由。解析成功后调用 `sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })`，由宿主校验并持久化。

- 新建 worker：`ria_spawn` 的 `model`/`provider`/`reasoningEffort`。模型在创建前解析，未知模型不会留下会话；创建后选模型失败会返回 `ok:false` + `sessionId`，明确说明该会话仍用默认模型。
- 已有 worker：`ria_model({ sessionId, model, provider?, reasoningEffort? })`。预检与 `ria_request` 一致（存在、top-level、未归档、cwd 可用），允许显式改 Ria 自己，但默认面向 worker。
- 状态：`ria_status` 的 session/recent 条目从会话的 `modelSelection` 投影读取 `provider`、`model`、`reasoningEffort`（未知时省略），不需要唤醒冷会话。

### 等待用户拍板（attention）

`blocked + waitingOn=user` 的 ticket 可以带 `attention`，把“在等什么问题、有哪些选项、什么时候问的”结构化存进 ria.json。`ria_status` 的任意 ticket 响应都会返回 `attentionOverview`：`waitingOnUser` 是票数，`items` 逐条给出问题；只有老 `blockedReason` 的历史票仍然可读，并标 `legacy=true`。ticket 离开 blocked、关闭或被 reopen 时会清空 attention。

`attention` 和 `ria_approval` 是两件事：`ria_approval` 只读地列出 **worker** 正在等待的审批，审批由 worker 会话和 UI answerer 处理；`attention` 是 **Ria 自己**需要用户拍板的问题（方案选择、是否继续、范围确认等），不会批准或拒绝任何 worker 操作。

### 近期 worker 与默认选择

用户派任务但没有指定 worker 时，manager prompt 要求 Ria 只从“近期用过”的顶层 worker 里选，不遍历全部会话，也不凭空挑一个没用过的。规则由 Host 的字段支撑，不把完整会话列表塞进 prompt。

- **近期用过的定义**：Host 成功接受过一次 ria_request 的顶层 worker；只创建或更新 ticket 不算。
- 时间窗口 7 天，最多返回 5 个，按 lastUsedAt 倒序。记录保存在 ria.json 的 recentWorkers，只保留最近 30 天，避免无限增长。
- ria_status 的 scope=recent 返回 sessionId、title、cwd、lastUsedAt、lastTicketId、lastTicketGoal、lastTicketStatus，以及 running/blank；缺失字段直接省略，保证输出是 lossless JSON。
- scope=sessions 也带 title 和 lastUsedAt，方便用户明确点名某个会话时核对；但默认挑选只要求看 scope=recent。
- 近期列表为空、没有一个明显合适、或 Ria 自己判断不清时，先问用户选哪个会话，不猜，也不退回“遍历全部会话”。
- title 来自 DSH 的 title projection；没有标题、没有 cwd 或不是近期用过的 worker，对应字段不输出。

### 审批可见性

- 插件在根上下文监听 `approval/request`，只记录有 open/working ticket 的 executor 的待审批请求：worker session、ticket、工具、callId、原因、时间。
- 记录后立即调用 `next()`，把决定权交回原有 UI answerer；插件从不改变审批结果。
- `ria_approval` 只返回当前 pending 列表。pending 在审批结束、AbortSignal 取消、15 分钟超时或 DSH 重启后清除。
- 不做自动唤醒或推送：用户问进度、或 Ria 主动检查时，才用这个工具查。
- 用户要批准/拒绝时，仍需打开对应 worker 会话操作；Ria 只能转告是哪个 worker、哪个工具、什么原因。

### 临时 worker 权限（阶段二）

当用户明确要求“临时放开某个 worker”时，Ria 才调用 `ria_grant`。它不是自动提权，也不会因为 worker 被审批卡住就自行放宽。

- `set` 必须由用户明确指令触发，且传 `userConfirmed=true`；Host 不提供任何自动 set 路径。
- 只作用在一个顶层 worker 上，至少指定 `sandboxMode` 或 `approvalPolicy`，可以关联一个未关闭的 ticket。
- 支持 `sandboxMode=read-only|workspace-write|danger-full-access` 和 `approvalPolicy=ask|never`。`never` 是自动拒绝需要审批的操作，不是自动允许。
- 默认 30 分钟过期，可设 60 秒到 24 小时；同一 worker 同时只保留一个 grant。
- Host 记录生效值和 override 原值，写入 `ria.json` 和 `audit.jsonl`；在 ticket done/cancelled、显式 reset、到期或 DSH 下次启动时恢复。
- 恢复是保守的：如果用户期间手工改过该字段，当前值已不等于 grant 写入的值，就跳过该字段并在结果里报告，不覆盖用户的新选择。
- 恢复失败会标记 `restore_failed`，60 秒后重试；审计里能看到失败原因。
- 不改 worker 的 tools、prompt 或 preset。

Ria 的系统 prompt 要求：每条真实用户消息都要用 `ria_resolve` 给出归宿（answered/work/merge/split/control/blocked），不能让它悄悄消失；需求不明确时先和用户澄清，再下发；不要凭猜测开工；任务要有验收标准；进度按需查询；经验按 case 集总结（需求、错误做法、正确做法），默认只在对话里输出，用户指定路径时才写文件；重启后先 read 再决定是否继续；收到 `[Worker idle]` 时先 read，确认完成才关 ticket，等用户输入就标 blocked；worker 明确拒绝任务或用户取消/叫停 worker turn 时，标 blocked 并停下来问用户下一步，不自行改派、重发或换方案；防误发提示由 agent system prompt section 提供，任务消息本身不加前缀；派发必须提供 note（一两句话：派给谁、做什么、用户接下来看到什么），Host 会把它显示成 Ria 会话当前轮次末尾的卡片，并同步一条微信文本；缺 note 或空白会直接报错、不投递，也不会结束本轮；成功派发后立即结束本轮，不再 sleep/poll；用户要求换 worker 模型时用 ria_model，新建 worker 要指定模型时用 ria_spawn 的 model 参数；只有用户明确要求时才使用 ria_grant，绝不自行放宽 worker 权限；用户没指定 worker 时只从 scope=recent 的近期 worker 里挑，近期没有合适的就先问用户，不遍历全部会话、不凭空挑。

## 任务与转述

- ticket 是管理记录，不是 DSH 内置对象；保存在 ria.json。
- 每条真实用户消息进入 Ria 的 turn 时，Host 在 `agent/pre-step` 自动登记一条 `intake` ticket，并在同一 turn 注入一条 `[Task intake]` 提示（source.kind=`ria-task-host`，不会被再次捕获）。Ria 必须用 `ria_resolve` 给出归宿；否则 `agent/turn-stopping` 会先 steer 提醒一次，第二次仍未给归宿就自动标成 `blocked`，并产生一张卡片。
- 8 个状态：`intake`、`open`、`working`、`blocked`、`forked`、`done`、`failed`、`cancelled`。`answered`、`merged`、`control` 是 `done.resolution.kind`。只有 `RiaStore.transitionTicket` 能改状态，非法转移返回错误而不是静默改写。
- request 是真正的 Session 消息。发送前先写 pending delivery，prompt 被接受后删除；失败保留，重启或下次 ensure 时按原 requestId 重试。
- `ria_request` 必须带 `ticketId` 和 `note`；ticket 的 executor 必须等于目标 sessionId。消息内容原样发送，不加任何前缀。防误发提示由 Host 注册在每个 agent 上的 system prompt section 提供：只有在做另一件明显不同的事或完全对不上时，才先向用户确认、不直接执行。
- note 最多 500 字。派发成功后，Host 把卡片和微信镜像都先写进副作用 outbox（`stateDir/outbox.json`）。有活跃 turn 时立即把 note 写入 `ria.json`（最多保留 100 条），插件 client 通过 `GET /plugins/dsh-ria/api/dispatch-notes?sessionId=...&turn=...` 读取，并在 `conversation.chat.turnTail` slot 渲染成当前轮次末尾的卡片；没有活跃 turn 时条目留在 outbox，下一次 turn/start、startup 或 30 秒 tick 补投；此保证仅适用于已成功持久化的条目。
- 卡片不属于 turn process，不会被完成后的流程折叠隐藏；它不进入模型上下文，也不依赖 session log；已经写入的卡片在重启后仍能从 ria.json 读到。
- note 缺失、纯空白或超过 500 字时，工具直接报错，消息不投递、不 concludeTurn。卡片写入失败会按 outbox 退避重试；6 次仍失败则标 failed 并保留原因，`ria_status` 可查，不阻断已经成功的派发。
- 同一个 note 也会在派发成功后进入副作用 outbox，再由微信内部 Outbound 队列发送“📌 任务已派发：<note>”。
- 微信文本会带前缀后再走现有 markdown/长度判定（阈值按包含前缀的完整文本计算）；note 最多 500 字，默认 800 字阈值下不会转成 .md，若配置了更低阈值则按同一规则处理。
- 微信发送失败（未登录、暂停、网络异常）由 outbox 按 10s/1m/5m/15m/1h 退避重试，最多 6 次；暂停期间不外发，恢复后若仍未超过重试窗口会补发。失败不影响派发，也不影响 concludeTurn。
- 早期实现用 `command/run` + `command/done`，但 DSH 把 turn 内 command 节点当作 process member，turn 完成后默认折叠，真实 UI 看不到。现已移除该路径。
- 该 section 是静态通用文本，对所有 agent 生效，内容不针对具体消息，因此对普通会话无害；它不修改 worker 的消息历史、tools 或 preset。设置页可以关闭它，关闭后 section 文本为空，DSH 会直接丢弃空 section。
- worker 的 turn 结束时 Host 会自动通知 Ria（见下节）；其余进度不轮询、不自动推送，Ria 需要时调 status/read。
- Ria 需要定时唤醒时，使用 DSH 官方 schedule_create；插件不实现调度循环。

### 派发 note 卡片与微信确认

![Ria 会话中任务派发后的 turn-tail 卡片](docs/ui-dispatch-note.png)

网页端在 Ria 当前轮次末尾显示“任务已派发 / 消息已转交”卡片；微信端同时收到一条以同样标题开头的文本。两处共用同一个 note 原文，措辞一致；网页看到卡片、微信收到文本是预期行为，不是重复发送。

### 副作用 outbox

派发卡片、微信镜像，以及恢复/blocked 时发给 Ria 的提示，都是“消息已经派发成功之后”的副作用。插件先将条目写入 `stateDir/outbox.json`，再由投递器执行；已成功持久化的条目在重启后可继续按退避和重试上限投递。这是至少一次（at-least-once）语义，发送成功但送达状态未落盘时可能重复；并非派发与副作用的原子事务。派发接受到 outbox 落盘前的崩溃，以及入队写盘失败，仍可能丢失确认，不能承诺所有副作用绝不丢失。

- 至少一次：条目在成功投递后才标 `delivered`；中途崩溃会重试。因此极端情况下微信可能收到重复文本；卡片按 `noteId` 去重，不会重复插入同一条 dispatch note。
- 幂等键由 kind、ticketId、note 文本与 turn 生成；重复入队返回已有条目，不重复发送。卡片与微信镜像共用同一个 noteId，卡片写入 ria.json 时再按 noteId 去重。
- 有活跃 turn 时立即投递卡片；没有活跃 turn 时不丢弃，留到下一次 turn/start、startup 或 30 秒 tick 补投。微信镜像不依赖 turn，入队后即可投递。
- 失败按 10 秒、1 分钟、5 分钟、15 分钟、1 小时退避，最多 6 次；超过后标 `failed` 并保留 `lastError`，不会静默消失。
- `delivered` 条目保留 24 小时用于去重，之后清理；队列上限 500 条，超限先清最旧的 `delivered`，再清最旧的 `failed`，`pending` 不清理。
- `ria_status` 的任意 ticket 响应带 `outbox` 汇总与未投递条目；带 `ticketId` 时只看该票。
- 微信服务自己的 `Outbound` 队列负责文本/文件/图片的串行发送与去重；副作用 outbox 负责“这条派发确认有没有送达”。两者层次不同，不要混用。

## 任务转交提示与设置页

防误发提示不是消息前缀，而是插件为每个 agent 注册的 system prompt section（name 为 dsh-ria:dispatch-guard，order 4100）。

- 插件启动时给已有 agent 安装，并监听 agent/created 给新 agent 安装；agent/disposed 和插件卸载时 dispose，避免重载时同名 section 冲突。
- section 文本是固定的通用提示，不按 ticket 或具体消息变化；关闭开关后 text 返回空字符串，DSH 的 renderPrompt 会丢弃空 section。
- 开关在“设置 > Ria”，默认打开；状态保存在 ria.json 的 settings.dispatchGuard。
- 开关只影响后续 system prompt 的组装，不改 worker 已经收到的历史消息、tools 或 preset；也不会替模型做硬拦截。

![设置中的 Ria 开关](docs/ui-settings.png)

## 任务归档

终态 ticket 不会无限留在 ria.json。热文件保留所有非终态，加上最近 24 小时内关闭的终态和按 closedAt 倒序最新 50 条终态；超出的写进 `~/.dsh/state/ria/tasks.log.jsonl`，并按 closedAt 的 UTC 月份同时追加到 `tasks-YYYY-MM.jsonl`（保留最新 12 个月）。先写成功再从内存删除；写失败时 ticket 留在 ria.json，下次启动重试。

`ria_status scope=history` 和 `ria_status ticketId=<id>` 会按需扫日志；`ria_ticket status=open` 与 `ria_resolve kind=control action=reopen/retry` 可以先把归档 ticket 捞回热存储再走正常转移，history/reopenCount 都会保留。

## 重启恢复

Host 启动后延迟 1.5 秒：

- 先补投副作用 outbox 里到期的条目（无需 Ria 在线也能发微信镜像）；补投不会创建 Ria。
- 没有未收敛 ticket、也没有 pending delivery：不再做其他事。
- 恢复单位是 ticket：`intake`（还没有归宿）、`open`（尚未派发）、`working`（worker 可能已中断）。`forked` 父容器只递归 `childTicketIds`，父本身不单独恢复；`blocked`、`failed`、`done`、`cancelled` 不自动恢复。
- 有 pending delivery 先重试；重试成功会把对应 ticket 拉回 `working` 并重置恢复计数。
- 所有候选 ticket 合并成一条恢复 prompt，逐条列出 ticketId、status、executor、goal、acceptance、原消息、开始时间、最近动作与 `recovery=n/3`。intake 要求先 `ria_read` 自己的会话再 `ria_resolve`；working 要求先读 worker 与工作区、检查已改文件和测试，再判断继续/done/failed/blocked；open 要求先检查 executor，再派发或标 blocked。
- 每个 ticket 连续自动恢复最多 3 次。达到 3/3 时不再发 prompt，而是把 ticket 标成 `blocked`，写入 `blockedReason`（自动恢复已达上限）与 `failure.code=recovery_exhausted`，并产生一次 `recovery_exhausted` 卡片；下一个启动不会再处理它。
- 恢复计数按 ticket 存在 `recovery.count`；`ria_ticket` 更新、成功派发或用户重新打开都会归零。因此它统计的是连续无人处理的重启次数。
- startup recovery 本身抛错时，也会向 Ria 发送失败通知（错误内容和“需要手动处理”），不只写日志。
- 旧的顶层 `inFlight` 记录在 schema v2 迁移时转成一条 `open`（或到上限时 `blocked`）ticket，`origin.kind=legacy_inflight`；迁移后不再有顶层 `inFlight` 字段。

## Worker 完成自动唤醒

默认开启。Host 监听 DSH 的 `agent/status` 事件；当某个正在执行的 worker 变回 `idle`，并且它是至少一个 `working` ticket 的 executor 时，给 Ria 发一条普通队列消息。Ria 不用轮询，也不会错过 worker 的结束点。

- 只读事件：从 worker 的事件日志读取最后一个 `turn/end` 的 reason，不改 worker 的 prompt/tools，不往 worker 会话写消息，也不 resume 冷 worker。唯一动作是唤醒 Ria；若最后一轮是 `aborted(user)`，同时把对应 `working` ticket 标为 `blocked`。
- 排除 Ria 自己，避免自我唤醒循环。
- 只匹配 `status=working` 且 `executor` 等于该 worker 的 ticket；`open`、`done`、`cancelled`、`blocked` 都不触发。
- 同一 worker + 同一 ticket 在 30 秒内只通知一次；多个 ticket 分别计时。
- 通知写明“worker X 的 turn 已结束”和最后一轮结束原因（`completed`、`blocked`、`error`、`aborted(user)` 等），并明确要求 Ria 用 `ria_read` 确认，不假设任务完成。`ria_read` 的返回值也带 `lastTurn`。
- 当原因是 `aborted(user)`（用户手动取消/叫停）时，通知明确写“必须停下来等用户决定”，不再建议发 continuation；对应 ticket 由 Host 标为 `blocked`，Ria 只需向用户报告并询问下一步。worker 在消息里明确拒绝任务时，Ria 同样标 `blocked` 后停下来问用户。`completed`、`blocked` 等其他原因保持原有流程，不被拦截。
- `idle` 仍无法区分“完成”“等用户输入”和“明确拒绝”，这三者要看 worker 最近消息；如果 worker 在等审批，通常仍是 `running`，不会产生 idle 通知。
- 通知投递失败只记 warn，不重试；worker 侧状态不受影响。

关闭或调整：

~~~yaml
- id: ria
  config:
    notifyOnWorkerIdle: false
    workerIdleThrottleMs: 30000
~~~

环境变量优先级更高：`DSH_RIA_WORKER_IDLE=0` 一键关闭，`DSH_RIA_WORKER_IDLE_THROTTLE_MS` 调整节流窗口（1 秒–10 分钟）。

日志前缀是 `dsh-ria: worker-idle:`。`info` 记录已通知、节流跳过和关闭状态，`debug` 记录“无 working ticket”等其他跳过原因。

## 状态文件

~~~text
DSH_HOME/state/ria/
  ria.json       # riaSessionId、riaPreset、tickets、pending deliveries、grants、settings、dispatchNotes
  outbox.json    # 副作用待投递/失败记录（dispatch note、微信镜像），0600
  memory.md       # 用户偏好和长期记忆
  audit.jsonl     # 临时权限审计，0600
  wechat/creds.json  # 微信登录凭据，0600
  wechat/state.json  # 已处理消息 id、Outbound 队列、暂停状态与时间
~~~

不保存聊天 transcript。Ria 的原始 Session 日志仍由 DSH 写在 DSH_HOME/sessions 下。

## HTTP API

前缀：/plugins/dsh-ria/api

- POST /ensure：创建或打开全局唯一的 Ria。
- GET /state：riaSessionId、tickets、pendingDeliveries、grants、settings、workerIdleNotifications（enabled/throttleMs）。
- GET/POST /settings：读取或设置 {dispatchGuard:boolean}；POST 的值不是布尔返回 400。
- GET /dispatch-notes?sessionId&turn：读取 Ria 的派发 note；sessionId 必须是当前 Ria，turn 可选且必须是非负整数；返回 {notes}。
- GET /health：健康检查。
- GET /wechat/status：微信登录和连接状态，含 paused/pausedBy/pauseReason/pausedAt/resumedAt/resumedBy。
- POST /wechat/login：获取登录二维码。
- POST /wechat/logout：退出微信登录。
- POST /wechat/start：用已有凭据重连。
- POST /wechat/pause：手动暂停或恢复推送，body {paused, reason?}。

所有请求校验 DSH 同源；没有额外的 loopback 端口。

## 测试

~~~bash
npm test
~~~

smoke 使用 mock ctx 覆盖 ensure、Workspace 挂载、10 个工具、request、ticket 派发都不加前缀、dispatch guard section 安装到 worker 和 Ria、GET/POST /settings 与 GET /state 的 settings、status、read、memory、持久化、grant 的 set/list/reset 与 ticket 关闭恢复，以及新建 Ria 不写任何 session 事件和第二次 ensure 不重复；近期 worker 覆盖空列表、ticket 派发后候选的 title/cwd/lastUsedAt/lastTicketGoal/lastTicketStatus、失败请求不更新、scope=sessions 字段、ria.json 持久化和 lossless；dispatch-guard 测试覆盖 installAll、agent/created 与 disposed、重复安装、开关关闭时 text 为空、注册失败只 warn 和 shutdown；wechat 测试覆盖 assistant 文本提取、入口事件过滤、微信入站去重/回显过滤、失败标记、reconnect skip、状态视图，以及图片入站预留；wechat-image 测试覆盖图片上传/发送字段与去重、成功发送、暂停、本机相对路径图片提取、缺失/非图片回退、围栏代码跳过和 outbound 关闭；wechat-file 测试覆盖阈值/代码块/表格/标题/链接判定、配置/env 覆盖、文件名、短消息不变、长消息发 .md、失败回退文本，以及上传 multipart 和 appmsg 的字段/签名/去重；approvals 测试覆盖只记录活跃 executor、始终 next()、abort/超时/shutdown 清理和 lossless 输出；grants 测试覆盖过期、startup、ticket 缺失/关闭、漂移跳过、恢复失败和审计；startup 测试覆盖达到恢复上限后的通知与 blocked 状态、更新/成功派发清零、以及启动异常通知；worker-idle 测试覆盖正常触发、排除 Ria、非 working ticket/running 状态不触发、按 ticket 节流、开关关闭，以及提示文本要求 read/不假设完成/等用户输入时标 blocked；wechat-pause 测试覆盖手动开关与持久化、非微信消息自动暂停、微信入站自动恢复、host_/schedule 合成消息不触发、manual 优先级、暂停时不出站且丢日志、排队丢弃而在途完成、重启保持，以及恢复后补发 outbox；smoke 还验证 pause/unpause 往返后 pausedAt、resumedAt、pausedBy 和重复读取 status 的字段一致；以及 dispatch-notes 按 session/turn 过滤、错误 session 返回空列表、note 持久化、无 note 的请求不记录、snapshot 读取失败仍派发并记录 note；wechat 和 smoke 还覆盖派发 note 的微信镜像：ticket 格式、未登录/暂停/发送异常都不影响派发与 concludeTurn，失败条目留在 outbox 并可按退避补投；spawn 测试覆盖新建顶层 worker 的参数、title、失败码与 ria_status 可见性；model 测试覆盖 ria_spawn 带 model、创建前拒绝未知模型、创建后 selectModel 失败的回执、ria_model 改模型与 previous、未知/歧义模型、归档/subagent/不存在会话、改 Ria 自己，以及 sessions/recent 的模型字段；attachments 测试覆盖图片 content 投递、attachment_missing/attachment_invalid/model_no_image、多目标部分成功，以及失败不投递、不写 recentWorkers、不动 ticket；attention 测试覆盖结构化问题的设置/读取/清空、旧 blockedReason 票和 ria_status 输出；outbox 测试覆盖幂等入队、重载、退避与 6 次上限、delivered 清理、坏文件恢复、无活跃 turn 排队、turn 开始后补投、失败原因可见和 startup 补投。

## 限制

- 微信协议依赖「文件传输助手」网页版；入站只投递文本（入站图片仍预留），出站可发文本、.md 文件与本机图片；出站图片只按网页版协议用 mock 验证过，尚未用真实微信账号完成一次图片收发验证。
- 暂停推送的界面入口只在 chip 弹层里；设置页“Ria”不重复放同一个开关，避免两个控制点。
- 暂停不能撤回已经在发送中的消息；只能保证之后排队的消息不发出。
- 暂停期间的连接保持和真实收发没有用真实微信账号验证，只做了单元测试和 HTTP smoke。
- 微信文件上传/发送链路按网页版协议实现并用 mock 覆盖，尚未用真实微信账号完成一次 .md 文件收发验证。
- 出站图片只在 assistant 文本里提取本机图片，不支持直接把 DSH 的 imagePart 或远程 URL 转成微信图片；入站图片仍未实现。
- 扫码登录、消息收发和派发 note 的微信镜像仍需要真实微信账号验证。
- 审批可见性只报告 pending，不代批、不自动唤醒 Ria；临时权限需要用户明确指令，Ria 不能自行判断后提权。
- worker 自动唤醒由 `agent/status` 的 `idle` 触发，能读到最后一轮 `turn/end` 的 reason（含 `aborted(user)`），但“明确拒绝”只能由 Ria 读消息判断；提示措辞不假设完成，需要 Ria 再 read。
- 不做 needs_input/failed 的独立事件级唤醒；需要时用官方 schedule 或用户回来问。
- worker-idle 通知没有在真实 worker 会话里触发过，只用 mock 事件验证。
- 不做多实例防双开。
- 澄清门禁是 prompt 行为，不是 Host 强制状态机。
- Ria 依赖 PTC preset；standard 模式不会作为后备。
- 额外创建一个 Ria Workspace 是当前 DSH UI 的硬要求。
- 欢迎卡片由 client 插件渲染（`conversation.input.dock`），不写 session 日志、不占 turn。Host 侧曾用合成的 assistant turn 显示欢迎气泡；该 turn 排在真实 turn 的 system/message 之前，v4 校验报 `system/message requires a protected first surface head`，重启加载历史 corrupt，因此废弃。
- 防误发提示是 agent system prompt 的行为约束，不是硬拦截；worker 仍可能直接执行明显无关的消息。设置页只开关该 section，不能保证模型遵守。
- note 卡片已在隔离 DSH 的真实 Web UI 中验证渲染：`[data-ria-dispatch-note="ticket"]` 出现在轮次末尾，标题“任务已派发”。该截图用手工写入 ria.json 的 note 验证 UI；真实 `ria_request` 写入路径由 smoke 覆盖。截图：`docs/ui-dispatch-note.png`。
- note 只保留最近 100 条；更早的卡片不会再显示。
- note 缺失/空白/超长是 Host 硬报错；note 展示失败只记 warn，不阻断已经成功的派发。
- 临时权限只在单元测试和 smoke 中验证过，还没有在真实 worker 会话里触发；首次使用时需要确认 DSH 的 sandbox/approval 事件投影和恢复行为。
- “近期 worker”只记录 Ria 成功派发过的会话；用户手工在其他会话里做的使用不会计入。挑选本身是 prompt 行为约束，不是 Host 强制，模型仍可能违背；尚未用真实模型验证。
- DSH 的 sandbox override 无法清除；恢复会写回原 effective mode，因此可能留下一个同值 override。

## 安全

- memory.md 和微信 creds/state 权限 0600；memory.md 禁止写凭据/token。
- 微信凭据只在本地 stateDir；没有额外的 loopback API，UI API 校验 DSH 同源。
- 不自动上传、不遥测。
- Ria 可以读 Session、发消息、建任务；这些能力只在用户明确要求时使用。
- `approval/request` 监听器只读：记录 pending 后调用 next()，从不返回审批结果。
- `agent/status` 监听器只读 worker 的 id 和状态，只向 Ria 发通知；不 resume、不写 worker。
- 临时权限只写当前 session 的 sandbox/mode 和 approval policy 投影，不改全局默认，也不改 worker 的 tools/prompt/preset；所有变更写入 audit.jsonl 0600。
- 删除 Ria 不会自动删除 ticket、memory 和 Workspace；需要时手动清理。
