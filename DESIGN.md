# dsh-ria 设计方案

> 状态：v0.29（2026-11-11）
> 目标目录：/home/gkl/Desktop/vibe_proj/dsh-ria
> Ria 固定用 PTC preset（agentPreset=ptc）启动，模型只直接看到 run_code + SDK。本文是设计说明；实现状态见第 20 节。

## 1. 定义

Ria 是全局唯一的普通顶层 DSH Session。

- 使用 PTC preset（agentPreset=ptc），拥有完整工具集。
- 模型只直接看到 run_code 和生成的 SDK；7 个 ria_* 工具通过 SDK 在 run_code 内调用。
- 在它的 Agent ctx 上额外注入管理者提示词和 7 个 ria_* 工具。
- 不是 subagent，不是 Agent Team Lead。
- 默认不替用户干活：把需求整理成 task，转交给 worker；用户明确要求时，也可以自己完成具体任务，不限于总结。
- 用户可以像普通会话一样打开、对话、看历史。

### PTC 启动

- ensure 创建 Ria 时固定传 agentPreset: 'ptc'。
- PTC preset 需要 DSH 的 ptc runtime 和 tool-executor-ptc；缺失时 ensure 明确失败，不静默退回 standard。
- 已有非 PTC 的 Ria 不自动改 preset；提示用户重建或迁移，避免 SDK/工具状态不一致。
- 7 个 ria_* 工具必须在 run_code SDK 生成前注册；否则模型看不到它们。
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
  |-- TaskRecovery（启动时继续未完成 task）
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

没有后台轮询，没有独立 bridge 进程；只有两个只读业务事件观察器：approval/request 记录后立即 next()，agent/status 在 worker idle 时通知 Ria。DispatchGuard 另外监听 agent/created 与 agent/disposed，用于安装和清理 system prompt section。

## 4. Task

task 是 Ria 的管理单位；一个 task 只对应一个 executor。

~~~json
{
  "taskId": "task_...",
  "goal": "修完 3 个失败测试，不改 public API",
  "acceptance": "回归全绿",
  "executor": "s_abc",
  "status": "open",
  "blockedReason": "",
  "createdAt": 0,
  "updatedAt": 0,
  "recoveryCount": 0
}
~~~

- executor=self：Ria 自己做，可以是总结，也可以是用户明确要求的具体工作。
- executor=sessionId：交给该 worker；用 ria_request 发送。
- status：open | working | blocked | done | cancelled。
- blockedReason：blocked 的原因，展示在 taskSummary 和 status 里。
- 每次 ria_task 更新或成功派发，recoveryCount 归零；只有连续无人处理的重启才累计。
- 广播给多个 worker：建多个 task。
- 不保存 title、kind、source、lastRelayId、lastRecoveryAt。

## 5. 工具

| 工具 | 作用 | 参数 |
|---|---|---|
| ria_task | 创建/更新/关闭 task | taskId?, goal, acceptance?, executor, status? |
| ria_status | 查 task、列可用顶层会话，或列近期 worker | scope: tasks/sessions/recent, sessionId? |
| ria_request | 以普通用户消息发送内容 | targetSessionIds, message, taskId?, mode? |
| ria_read | 读会话最近消息 | sessionId, limit? |
| ria_approval | 列出等待审批的 worker | action: list |
| ria_grant | 临时调整 worker 的 sandbox/审批策略，并记录原值 | action: set/list/reset, sessionId?, taskId?, sandboxMode?, approvalPolicy?, ttlSeconds?, reason?, grantId?, userConfirmed? |
| ria_memory | 读写 memory.md | action: read/remember/forget, text?, key? |

共同规则：

- 只在 Ria Agent ctx 注册。
- PTC 下不直接调用工具；模型写 run_code，通过 SDK 调用 tools.ria_*。
- 工具必须在 run_code SDK 生成前完成注册；Phase 0 验证。
- 不伪造用户消息之外的身份，不改 worker 的 preset/tools；只追加一个可关闭的通用 system prompt section。
- taskId 只用于关联状态，不是发送门禁。
- broadcast 或 steer 前先向用户确认。

### 近期 worker

“近期用过”只按 Host 成功接受过的 ria_request 计算：task 派发和 quick relay 都算，只建/改 task 不算。用户手工会话不计入。

- 窗口 7 天，最多返回 5 个，按 lastUsedAt 倒序；ria.json 保留 30 天后清理。
- scope=recent 返回 sessionId、title、cwd、lastUsedAt、lastTaskGoal、lastTaskStatus，以及 windowDays=7、limit=5、pendingDeliveries。
- scope=sessions 也带 title、lastUsedAt；title 来自 DSH 的 title projection，缺失时省略该字段。
- 用户没指定 worker 时，Ria 只能从 scope=recent 里选；不得遍历全部会话，不得凭空挑一个没用过的。
- scope=recent 为空、没有明显合适或 Ria 判断不清时，先问用户用哪个会话；不回退到任意或新会话。
- 用户明确给出 sessionId 时可直接用，必要时用 scope=sessions 校验是否为顶层。
- 所有可选字段条件写入，保证 PTC 输出是 lossless JSON。
- 选择规则是 manager prompt 约束，不是 Host 强制；Host 只负责记录和返回候选。

### 审批可见性（阶段一）

- 根 ctx 监听 `approval/request`，只记录 executor 有 open/working task 的 worker；Ria 自身、subagent、无活跃 task 的会话不记。
- 记录 approvalId、workerSessionId、taskId、toolName、callId、reason、createdAt、expiresAt、AbortSignal；随即 `next()`，不接管、不代批。
- `ria_approval` 只返回 pending 列表；无参数时需要 action=list。
- 清理：审批结束或 next() 抛错时 finally 清除；AbortSignal abort、15 分钟 TTL、插件 shutdown、DSH 重启都清除。
- 该观察器不改变审批结果；没有 UI answerer 时仍由 DSH 返回 unavailable。
- 不做自动唤醒、推送或审批决策；用户必须打开对应 worker 会话批准/拒绝。

### 临时 worker 权限（审批阶段二）

- 只在用户明确要求时调用 `ria_grant`；`set` 必须带 `userConfirmed=true`。Ria 不得因为 task blocked、审批卡住或自己的判断自动提权。
- `set` 一次只改一个顶层 worker，至少指定 `sandboxMode` 或 `approvalPolicy`，可关联一个未关闭且 executor 匹配的 task。一个 worker 同时只能有一个有效 grant。
- 修改前记录 effective sandbox mode、sandbox override、effective approval policy、approval override；sandbox 通过 `session.append('sandbox/mode')` 写入，approval 通过 `ctx.approval.setPolicy(agent, policy)` 写入。
- `approvalPolicy=never` 表示需要审批的动作会被拒绝，不是自动允许；不要把它当作“放开权限”。
- 默认 TTL 30 分钟，允许 60 秒到 24 小时。
- 恢复时机：关联 task 变成 done/cancelled、显式 `reset`、TTL 到期、下次启动 reconcile。恢复前比较当前 override；若用户已经手工改过，不覆盖，记入 skipped。
- 恢复失败标记 `restore_failed` 并 60 秒后重试；启动时先 reconcile 再做其他恢复。
- 审计追加到 `stateDir/audit.jsonl`（0600）：grant/set、grant/active、grant/apply_failed、grant/restore_failed、grant/restored。
- 不改 worker tools、prompt 或 preset；只改 DSH 已有的权限 override。
- 已知限制：DSH 没有“清除 sandbox override”的 API，恢复时只能写回原 effective mode，可能留下一个同值的 override；effective 行为一致。

## 6. Request

request 就是一条普通会话消息，没有单独的消息类型体系。

- message 直接使用 DSH Session 支持的内容：文本、图片、文件等。
- 不做额外的文件分类、根目录白名单或专用上传流程；由 DSH 现有 message/content 能力处理。
- 带 taskId 的任务派发必须提供 note（一两句话：派给谁、要 worker 做什么、用户接下来会看到什么），最多 500 字。Host 在投递成功后、concludeTurn 之前，把 note 写入 ria.json（最多保留 100 条），插件 client 在 conversation.chat.turnTail 渲染为当前轮次末尾的卡片。卡片独立于 turn process，不会被完成后折叠；不进入模型上下文，重启后仍可读取；通过 GET /api/dispatch-notes?sessionId&turn 查询。早期用 command/run + command/done，卡片被 ChatNodeSeat 当作 process member 折叠，真实 UI 不可见，已移除。
- note 缺失、纯空白或超过 500 字时，工具直接报错：不投递、不写 delivery、不 concludeTurn。报错文案分别是 requires a non-empty note when taskId is set 和 note is N characters; the maximum is 500；超长不截断。
- note 展示失败（例如 Ria 的 session 还没有 append 能力或 append 抛错）只记 warn，不阻断派发，也不影响已经成功的请求；成功派发仍然 concludeTurn。
- quick relay（不带 taskId）不需要 note；如果提供了 note，也会显示一条“消息转发”卡片（同样受 500 字限制），否则不产生卡片。消息原样转发。
- 带 taskId 的任务派发和不带 taskId 的 quick relay 都原样发送，Host 不在消息里插入任何 text part 或前缀。
- 防误发提示由 DispatchGuard 提供：为每个 agent 注册 name=dsh-ria:dispatch-guard、order=4100 的静态 system prompt section。文本是简短英文 2 句、无标题、不提 Ria 或其他会话名：最新消息若与本会话当前工作明显无关，先向用户确认再执行。只保留这一条约束，不再额外说明空闲或相关时应当放行。对所有 agent 生效，对普通会话无害。
- section 通过 agent.ctx.systemPrompt.section 安装；apply 时遍历 ctx.agents.list() 补装，并监听 agent/created；agent/disposed 和插件卸载时 dispose，避免同名 section 重载冲突。
- 开关在“设置 > Ria”，默认打开，持久化在 ria.json 的 settings.dispatchGuard。关闭后 text 返回空字符串，DSH 的 renderPrompt 丢弃空 section；开关只影响后续 system prompt，不改历史消息、tools 或 preset。
- 该提示只是行为约束，不是硬拦截；Host 看不到 worker 的内部上下文，无法判断是否真的发错。
- source 是 user-rpc，worker 看到的就是普通用户消息。
- requestId 每目标独立；重试复用同一个 requestId。
- 可带 taskId；task.executor 必须等于目标 sessionId。发送成功后 task.status=working。
- 不带 taskId 的 request 是普通消息，不改变 task。
- 成功投递后把每个目标记入 recentWorkers（lastUsedAt，taskId 存在时记 lastTaskId）；失败不记录。
- 默认 queue；用户明确要求打断时才 steer。

pending request 记录 target、requestId、taskId、content、mode；成功后删除，失败保留，重启后按原 requestId 重试。

关于这条提示的调研、替代方案和落地步骤，见 docs/system-dispatch-guard.md；v0.23 已按其中的静态 section 方案实施，并增加设置页开关。

## 7. Prompt

初始 prompt 用原则和少量示例，不写死步骤。

- 先理解目标和验收，再决定自己干还是交给 worker。
- 任务型需求先复述；只问阻塞问题；用户说“先做/你看着办”时记录假设后继续。
- 普通转述和“原话发给 X”不强制澄清。
- 需要跟踪就建 task；不需要就是普通 request。
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
- 不放 task 进度、聊天记录、worker 细节、凭据。
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

ria_status 按需读取，不后台轮询；唯一主动推送是 worker idle 通知（见 9.1）。

- scope=tasks：task 列表。
- scope=sessions：可用的顶层 Session，排除 Ria 自己、subagent、带 parentSessionId 的会话；字段含 sessionId、title、cwd、running、blank、updatedAt、lastUsedAt。
- scope=recent：近 7 天成功使用过的顶层 worker，最多 5 个，按 lastUsedAt 倒序；字段见第 5 节“近期 worker”。
- 可选 sessionId 查看一个会话的 running/queue/pendingInput/blank。

ria_read 只读最近消息，默认 30 条，最多 100 条，不 resume 冷会话。

定时用官方 schedule_create/list/view/edit：

- target 只能是 this_session。
- title 带“Ria:”前缀；用完删除。
- 插件不实现 timer、不存 nextAt。

### 9.1 Worker idle 唤醒

Host 监听 agent/status（payload 为 { agent, status }）。当 status 变为 idle，且该 session 是至少一个 working task 的 executor 时，给 Ria 发一条 mode=queue 的普通消息。

- 只读：不读 worker transcript，不写 worker，不改 worker prompt/tools，不 resume 冷 worker；唯一动作是 ensure Ria 并 prompt Ria。
- 排除 Ria 自身，避免自我唤醒循环。
- 只匹配 status=working 的 task；open/done/cancelled/blocked 不触发。
- 节流键是 workerSessionId + taskId，默认 30 秒；多 task 分别计时，同一次事件只发一条消息。
- 文本固定以 [Worker idle] 开头，只写“turn 已结束”，要求 Ria 先 read 确认，不假设完成；等用户输入/决定时标 blocked，继续时发 continuation。
- idle 无法区分完成、失败和等用户输入；审批 pending 通常仍为 running，因此不会产生 idle 通知。
- 配置 notifyOnWorkerIdle（默认 true）、workerIdleThrottleMs（默认 30000，1 秒–10 分钟）；环境变量 DSH_RIA_WORKER_IDLE、DSH_RIA_WORKER_IDLE_THROTTLE_MS 优先。
- 日志记录 enabled/disabled、notify、throttled、no working task、Ria skip；投递失败只 warn，不重试。

## 10. 启动恢复

重启后 worker 的 turn 已经中断；恢复以 task 和 Ria 自己的未完成 turn 为单位。

| 情况 | 处理 |
|---|---|
| pending request：原消息没送达 | 用原 requestId 重试 |
| 已送达但 task 未完成 | 用新 requestId 发 continuation |
| Ria 自己的 turn 未收尾 | 发一条恢复 prompt，让 Ria 先 read 自己的会话再继续 |

步骤：

1. 读 ria.json。
2. 重试 pending request；失败保留。
3. 如果原 request 仍在 pending 且重试成功，不追加 continuation。
4. 收集 status=open/working 且没有 pending request 的 task；同时读顶层 `inFlight`（记录 Ria 当前/上一个未完成 turn：turnId、startedAt、lastUserMessage、lastPhase、recoveryCount）。
5. 没有 active task、没有 `inFlight`、也没有 pending request 就安静结束。
6. recoveryCount 已经达到 3 的 active task 先标成 blocked，写入 blockedReason（自动恢复已达上限），不再继续累计；`inFlight.recoveryCount` 达到 3 时清掉记录，只在本次 prompt 里提示一次“已达自动恢复上限”。
7. 只有存在 candidate、exhausted task 或 `inFlight` 时才 ensure Ria。
8. 给 Ria 发**一条** prompt：`inFlight` 部分说明上次 turn 未完成、附开始时间与用户消息摘要（及最近工具名），要求先 `ria_read` 自己的会话、检查工作区，再从中断处继续；candidate 部分列出 goal、acceptance、executor、recoveryCount；exhausted 部分单独列出 taskId、executor、goal，并明确说明已超过自动恢复上限、需要用户手动处理。各部分之间空行分隔，绝不发两条。
9. candidate 的 recoveryCount 加一；`inFlight.recoveryCount` 同样加一；同一对象连续自动恢复最多 3 次。
10. `inFlight` 的写入与清除：Ria 收到真实用户消息（source.kind=user 且 rpcId 不是 host_ 前缀）时写入一次，turn/end completed 或用户主动停止（aborted/user）时清除；崩溃或进程重启不会写 turn/end，记录因此留给下次启动。工具名只在内存跟踪，turn 异常结束落盘一次，不每次 tool/call 写盘。
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
- 暂停期间不写 outbox：assistant 回复、系统提示和长回复转文件都在入队前被拦截并记录。
- 暂停前已经在 outbox 里的待发消息保持不发送；恢复时再按重连积压策略补发（超过 10 条只发最后 10 条并先提示）。
- 暂停期间微信入站消息仍正常投递给 Ria，因此会话历史完整。

日志（logger 前缀 dsh-ria: wechat:）：

- 暂停：warn，pause: 后接 JSON，字段为 at、pausedBy、reason、dropped（本次丢弃条数）、inFlight（是否有在途消息）。
- 恢复：info，resume: 后接 JSON，字段为 at、resumedBy、reason、previousPausedBy。
- 丢弃：warn，dropped outbound while paused: 后接 JSON，字段为 at、riaSessionId、to（filehelper）、kind（assistant/system/text/file）、pausedBy、reason；text 另有 chars、preview，file 另有 name、bytes。
- 自动暂停被手动暂停拦下：info，auto pause ignored: manual pause is active。

### 11.3 派发 note 同步到微信

turn-tail 卡片是插件 client 渲染的，微信桥只转发 assistant/message 文本，因此卡片本身不会到微信。派发成功后，Host 额外把同一段 note 作为一条普通文本放进 WechatService 的 outbound 队列，与卡片并存。

- 触发点：ria_request 成功（所有目标都被 Host 接受）且 note 通过校验。任务派发和带 note 的 quick relay 都触发；没有 note 的 quick relay 不产生微信消息。
- 格式：任务为“📌 任务已派发：<note>”，quick relay 为“📌 消息已转交：<note>”。只加一行前缀，不包长模板，note 原文不改。
- quick relay 有 note 也推送：网页端同样会显示“消息已转交”卡片，微信侧保持同样的确认；没有 note 时本来就没有卡片，也不应该凭空多一条微信。
- 通道：调用 WechatService.sendDispatchNote，内部走 deliverAssistant -> Outbound.enqueue，因此和普通回复共用串行队列、markdown/长度判定和暂停开关；发送失败不写 outbox。
- 暂停：入队前检查 state.paused；已暂停则丢弃并记 dropped outbound while paused，kind=dispatch-note，不绕过。暂停竞态由 deliverAssistant/PauseError 兜底，同样记日志。
- 未登录：没有 outbound 时跳过并记 info（WeChat is not connected; skipped dispatch note），不影响派发。
- 失败：只记 warn（could not send dispatch note to WeChat: ...），不影响 ria_request 的成功结果，也不影响 concludeTurn。微信通知不写 outbox 重试，避免事后补发一条已经过时的派发确认。
- 长度：前缀加 note 后按现有规则判断，阈值按包含前缀的完整文本计算；note 上限 500 字，默认 800 字阈值下不会转 .md，若配置更低阈值则照常转文件。
- 与 turn-tail 卡片的关系：网页显示卡片、微信收到文本是预期双份；两处使用同一个标题语义和同一段 note 原文，措辞一致。

### 11.4 图片接口（预留）

微信图片收发只预留接口，不实现完整链路。配置为 wechatImage.inbound / wechatImage.outbound，两个开关默认都是 false；文本、文件和暂停路径不读取这两个开关。

- 入站识别：InboundBridge 用 isImageMessage 判断 MsgType 3。inbound=false 时仍走原来的“目前只能接收文本消息”提示，不进入图片分支；inbound=true 时才调用 WechatService.deliverImageFromWechat(message)。
- 入站转换：lib/wechat/image.mjs 的 imagePartFromMessage(message, { client, signal }) 是预留签名，负责解析 message.raw.Content 里的 img 元数据、用已登录的 WebWxClient 下载原图、识别 mediaType 并 base64 编码，返回 DSH 的 { type: 'image', mediaType, data, name? }。当前函数体只有 TODO，并抛出 “WeChat inbound images are reserved but not implemented”，避免投递半成品。
- 入站投递：deliverImageFromWechat 已经按普通 prompt 的形状写好（requestId 用 wx_ 前缀、mode=queue、content=[imagePart]）；实现转换函数后即可工作。
- 出站：Outbound.enqueueImage({ name, buffer, mime, ref }) 是预留签名，TODO 是上传图片并按网页版协议发送 Type=6 appmsg；当前调用直接 reject，不会被现有 assistant 文本或 .md 文件路径调用。
- 默认关闭，且没有 UI 开关；图片功能未实现前不建议打开 inbound。

## 12. 状态文件

~~~text
stateDir/
  ria.json
  memory.md
  audit.jsonl      # 临时权限审计，0600
  wechat/
    creds.json      # 登录凭据，0600
    state.json      # seen 消息 id（上限 500）、outbox（上限 50）、暂停状态与时间
~~~

没有 lessons、lock、briefs、outbox。

ria.json 只存 riaSessionId、riaPreset、tasks、deliveries、grants、settings、recentWorkers、dispatchNotes：

- recentWorkers：sessionId -> lastUsedAt、lastTaskId?；只在 request 成功投递后写入，30 天后清理。

- settings：dispatchGuard（boolean，默认 true）。
- dispatchNotes：noteId、sessionId、turn、note、isTask、at、taskId?；最多保留 100 条，供 turn-tail 卡片读取。

- tasks：taskId、goal、acceptance、executor、status、blockedReason、createdAt、updatedAt、recoveryCount。
- deliveries：deliveryId、targetSessionId、requestId、taskId、content、mode、createdAt。
- grants：grantId、sessionId、taskId、status、createdAt、expiresAt、before、after、reason、lastError。

写入：进程内 mutex、临时文件 + fsync + rename、0600。pending request 成功后删除，失败保留。

Session 日志由 DSH 持久化：

~~~text
DSH_HOME/sessions/<workspace-key>/session-<uuid>/session.v4.jsonl.zstd
~~~

ria.json 和 memory.md 都不存 transcript。

## 13. UI

- sidebar.panellist 注册 Ria，order 100，label "Ria"。
- 点击后瞬时 launcher -> ensure -> openSession。
- DSH 的正常会话界面要求 Session 属于一个 Workspace。ensure 在 stateDir 创建/复用标题为 Ria 的专用 Workspace，并用 workspaceId 创建 Session；旧 Ria 通过 attachSession 补挂。工作区列表会多这一项，这是输入框可用的必要条件。
- 不做常驻看板。
- 新建 Ria 第一次打开（会话还没有任何 turn）时，输入框上方显示一张欢迎卡片：提示选模型、设置权限（建议 danger-full-access + 审批策略）、直接说目标。
- 欢迎卡片是 client 侧渲染：注册在 `conversation.input.dock`（id=ria-welcome，order 5），只在当前会话等于 Ria 且 `blank` 时显示，发出第一条消息后自动消失；不写 session 日志、不占 turn、不调用模型、不进入模型上下文。
- 早期实现是 Host 侧由 Session.append 写一个合成的完整 turn（turn 1/step 1）。该 turn 的 assistant/message 会成为 surface 的首个节点，排在真实 turn 的 system/message 之前，DSH session-format v4 校验要求 system/message 是 protected first surface head，因此重启 resume 报 corrupt（`system/message requires a protected first surface head`），已移除。
- 带 taskId 的派发 note 由 Host 记录到 ria.json（最多保留 100 条），插件 client 在 `conversation.chat.turnTail` slot 渲染为当前轮次末尾的卡片，标题「任务已派发」/「消息已转交」。卡片不属于 turn process，不会被完成后折叠；不进入模型上下文；通过 GET /api/dispatch-notes?sessionId&turn 读取。早期用 command/run + command/done，卡片被 ChatNodeSeat 当作 process member 折叠，真实 UI 不可见，已移除。
- 微信 chip 在 Ria 入口标题右侧，点击打开微信弹层。
- 设置页注册 settings.section：id=ria-settings、order=25、label=Ria；一个“任务转交提示”开关，默认打开，POST /settings 持久化。说明文字明确：只影响后续 system prompt，不改 worker 历史、工具或预设。

## 14. 安全

- UI API 校验 DSH 同源。
- 微信客户端在进程内，没有额外 loopback API。
- memory.md 0600；禁止写凭据/token。
- 不自动上传、不遥测。
- 单 Host 假设；两个 DSH 实例可能双开。
- 删除 Ria 不删除 task、memory.md 和微信凭据。

## 15. 阶段

Phase 0：验证 PTC preset 创建（agentPreset=ptc）、run_code SDK 暴露 7 个 ria_*、user-rpc、sidebar launcher、schedule、微信扫码/收发。

Phase 1：单例、ensure、task、7 个工具、request、read、pending request 重试、入口。

Phase 2：启动恢复、continuation、recoveryCount。

Phase 3：memory.md、remember/forget、冷启动注入、case 集输出与按路径保存。

Phase 4：微信进程内服务、回复同步、积压 skip、入口 chip。

Phase 5：审批可见性 observer、ria_approval list、清理与 TTL。

Phase 6：新建 Ria 的一次性欢迎提示（最初是合成 assistant turn 1，不调用模型；合成 turn 早于真实 system/message，v4 校验失败，已改为 client 卡片，见第 13 节）。

Phase 7：任务派发防误发提示（最初实现为仅带 taskId 的 request 插入固定 text part；Phase 13 已改为静态 system prompt section 并删除前缀）。

Phase 8：临时 worker 权限 grant（set/list/reset、原值记录、task 关闭/过期/启动恢复、审计）。

Phase 9：微信出站长回复/复杂 Markdown 转 .md 文件（可配置阈值和复杂度规则、完整文件、失败回退文本）。

Phase 10：恢复上限可见性（达到上限的 task 标 blocked + blockedReason，通知 Ria 并列出放弃的 task；startup 异常也通知；task 更新/成功派发清零 recoveryCount）。

Phase 11：worker idle 自动唤醒（agent/status 只读监听、working task executor 过滤、排除 Ria、按 worker+task 30 秒节流、可配置开关、mock 测试）。

Phase 12：微信暂停推送（只停出站、连接保持；手动 pause/status API；非微信用户消息自动暂停、微信入站自动恢复；manual/channel 优先级；队列丢弃与在途完成；持久化与重启恢复）。

Phase 13：静态 system prompt section 防误发提示（对所有 agent 安装、可开关、默认开启），移除 task 派发的消息前缀，增加设置页。

Phase 14：近期 worker 选择（成功 request 记录 recentWorkers；status 增加 scope=recent 与 title/lastUsedAt；manager prompt 规定默认从近期 worker 里挑，空或不确定时问用户）。

Phase 15：微信暂停推送 UI（chip 弹层显示“推送中 / 已暂停推送”、来源与时间、手动暂停/恢复按钮；自动暂停时弹层内和侧边栏右下角各一条 8 秒轻提示；chip 圆点显示暂停色）。

Phase 16：note 硬约束（带 taskId 的 request 必须传 note，最多 500 字；缺失/空白/超长直接报错且不投递；Host 在 concludeTurn 前把 note 记录到 ria.json，由 client 在 conversation.chat.turnTail 渲染可见卡片，失败只 warn；quick relay 不受影响）。

Phase 17：派发 note 同步微信（task note 发“📌 任务已派发：<note>”，带 note 的 quick relay 发“📌 消息已转交：<note>”；走现有 outbound 队列和暂停门禁；未登录跳过；发送失败只 warn，不影响派发和 concludeTurn）。

Phase 18：微信图片接口预留（识别 MsgType 3、入站下载/转换/投递签名与 TODO、出站 enqueueImage 签名与 TODO；wechatImage.inbound/outbound 默认 false，文本路径不变）。

## 16. 验收

1. 点击入口只创建一个 Ria。
2. Ria 以 agentPreset=ptc 创建；模型只直接看到 run_code，7 个 ria_* 通过 SDK 可用。
3. 没有 attach/detach。
4. request 在 worker 中显示为普通用户消息，支持 DSH 支持的消息类型；task 派发和 quick relay 都原样发送，不加消息前缀。
5. 一个 task 只有一个 executor；self 可做用户明确要求的任务，session 做分派任务。
6. 重启后 pending request 原 requestId 重试；已送达 task 用新 requestId 继续。
7. 同一 task 连续自动恢复最多 3 次；达到上限后标 blocked 并通知，不静默跳过；task 更新或成功派发清零 recoveryCount。
7.1. startup recovery 抛错时向 Ria 发送失败通知，不只写日志。
8. memory.md 跨重启保留；冷启动注入；remember/forget 可用；当前消息优先。
9. 没有 lessons/FTS5；经验默认只在上下文，用户给路径才写文件。
10. 微信进程内运行，无 bridge 端口/socket；消息进 Ria，回复回微信。
11. 微信积压超过 10 条时只发最后 10 条并提示。
12. 微信 chip 在 Ria 入口右侧，宽侧边栏显示。
13. 审批 observer 只记录活跃 task executor，记录后调用 next()，从不改变审批结果；abort/超时/重启后不残留 pending。
14. 新建 Ria 的首次打开显示一次欢迎卡片；只在会话 blank 时由 client 渲染，不写 session 日志、不占 turn 和用户消息位、不调用模型；已存在/重启不重复。
15. 防误发提示由 agent 作用域 system prompt section 提供，对所有 agent 生效；要求 worker 对明显无关的消息先确认；设置页可关闭，关闭后 text 为空；任务和 quick relay 的消息内容都不变。
16. 临时权限只能由用户明确指令触发；set 需要 userConfirmed=true；记录原值；task close/reset/expiry/startup 恢复；手工改动跳过；审计可查。
17. 微信长回复/复杂 Markdown 按可配置规则转完整 .md 文件；短消息不变；文件发送失败回退文本并提示。
18. 达到恢复上限的 task 不再停留在 working；状态为 blocked，blockedReason 可见，且 Ria 收到包含 taskId/executor/goal 的通知。
19. startup recovery 异常时 Ria 收到失败通知；通知失败不能吞掉原始错误日志。
20. worker 结束 turn 变 idle 时，只有 working task 的 executor 触发一次通知；Ria 自己、非 working task、节流窗口内重复 idle 都不触发。
21. idle 通知只读 worker，不写 worker、不 resume 冷会话；通知文本要求 read 确认且不假设完成。
22. idle 通知默认开启，可通过配置或环境变量一键关闭；关闭后不注册监听，日志说明原因。
23. 通知投递失败只记 warn，不影响 worker 状态，也不改变 task。
24. 微信暂停只停出站，连接、登录态、轮询和入站不受影响，不需要重新扫码。
25. 手动暂停/恢复通过 POST /wechat/pause，状态在 GET /wechat/status 可见，并跨 DSH 重启保持。
26. 非微信用户消息自动暂停，微信入站自动恢复；host_ 合成消息和 schedule 提醒不触发切换。
27. 手动暂停不被自动暂停覆盖；微信入站可以恢复手动暂停；手动恢复后下一条非微信消息再次暂停。
28. 暂停期间在途消息发送完成，排队消息丢弃并记录日志；outbox 不发送，恢复后补发。
29. 暂停相关测试覆盖手动开关、自动切换、合成消息过滤、优先级、队列竞态、日志和重启持久化。
30. 带 taskId 派发必须传 note（最多 500 字）；缺失、空白或超长直接报错，不投递、不 concludeTurn；成功后 Host 把 note 写入 ria.json，由 client 在 conversation.chat.turnTail 渲染为当前轮次末尾的可见卡片，再 concludeTurn；note 展示失败只 warn；quick relay 不需要 note。
31. 设置页默认 dispatchGuard=true；关闭后所有已安装 section 的 text 返回空字符串；POST /settings 只接受 boolean 并持久化到 ria.json；GET /state 可见 settings。
32. manager prompt 明确：用户未指定 worker 时只从 scope=recent 选择，不遍历全部会话，不凭空挑没用过的；没有合适候选时先问用户。
33. “近期用过”定义为成功 ria_request 过的顶层 worker，窗口 7 天、最多 5 个、保留 30 天；task 创建/更新不算，用户手工会话不算。
34. scope=recent 返回 sessionId、title、cwd、lastUsedAt、lastTaskGoal、lastTaskStatus；scope=sessions 也带 title、lastUsedAt；缺失字段省略且输出 lossless。
35. 投递失败不更新 recentWorkers；quick relay 成功也更新 lastUsedAt。
36. 微信弹层显示推送状态（正常“推送中”，暂停“已暂停推送”+ 来源 + 时间），按钮可手动暂停/恢复并立即刷新；自动暂停时只出现轻提示，不弹窗；设置页不重复提供同一开关。
37. 带 note 的 task 派发成功后，微信收到一条“📌 任务已派发：<note>”；带 note 的 quick relay 收到“📌 消息已转交：<note>”；无 note 的 quick relay 不产生微信消息。note 走现有 outbound 队列：暂停时丢弃并记日志，未登录跳过，发送失败只 warn，不影响派发和 concludeTurn。网页卡片与微信文本并存，使用同一段 note 原文。
38. 微信图片只预留接口：wechatImage.inbound/outbound 默认 false；默认关闭时文本收发、文件、暂停、去重和 outbox 不变；入站识别 MsgType 3 但转换函数明确报未实现；出站 enqueueImage 只保留签名并明确 reject。

## 17. 已确认

- task 单 executor；广播建多个 task。
- Ria 所有 assistant 回复同步微信。
- 微信积压 N=10。
- memory 只做 memory.md，不做 lessons/FTS5。
- 微信设置在入口右侧 chip。
- 微信长回复/复杂 Markdown 转 .md：默认 800 字，代码块/表格/4 标题/6 链接任一命中。
- request 是普通会话消息，使用 DSH 支持的消息类型。
- worker idle 通知默认开启，节流 30 秒；只对 working task 的 executor 触发。
- 微信暂停默认不启用；手动 pause 优先于自动 pause；微信入站总是恢复。
- 防误发提示使用静态 system prompt section，对所有 agent 生效；任务消息不加前缀。
- 设置页提供 dispatchGuard 开关，默认打开。
- 派发 note 同时写 ria.json（网页卡片）和微信 outbound（文本）；quick relay 有 note 也推送，没有则不推。
- 微信图片收发先只预留接口，开关 wechatImage.inbound/outbound 默认关闭；不实现下载/上传。

## 18. 风险

| 风险 | 处理 |
|---|---|
| PTC preset/runtime 不可用 | Ria 无法创建或工具不可见 | ensure 明确报错；不静默退回 standard |
| 已有 Ria 不是 PTC | preset 不一致 | 提示重建/迁移，不自动改 |
| PTC SDK 未包含自定义工具 | Ria 无法调用 7 个工具 | Phase 0 验证注册时序；必要时延迟 SDK 生成 |
| task 状态依赖 Ria 维护 | 重启先 read；用户可纠正 |
| 自动恢复误判 | 先 read；连续最多 3 次；达到上限标 blocked 并通知 |
| 恢复额度被无关重启耗尽 | task 更新或成功派发清零 recoveryCount；达到上限仍可见可处理 |
| 启动恢复失败无感知 | catch 中除日志外，再向 Ria 发失败通知；通知异常单独记录 |
| memory 过期/膨胀 | 当前消息优先；4KB 上限；用户可删 |
| 微信全量同步 | 已接受；后续可做 turn 关联 |
| 微信长连接绑 DSH 进程 | 重启加载 creds 重连，通常不扫码 |
| 微信文件上传协议随网页版变化 | 规则命中时尝试上传/发 appmsg；任一步失败回退文本并提示 |
| 入口 chip 是 DOM 注入 | MutationObserver；宽侧边栏才显示 |
| 欢迎消息写进 session 日志 | 合成 turn 的 assistant/message 早于真实 system/message，v4 校验失败（system/message requires a protected first surface head），重启 resume corrupt；已改为纯 client 卡片，不写日志 |
| 临时权限被滥用 | 只能用户明确指令 + userConfirmed；单 worker、单 grant、TTL 上限 24h；task close/启动恢复；审计 |
| 恢复时覆盖用户手工改动 | 比较当前 override，不一致则跳过并记录 |
| idle 误判为完成 | 通知只写 turn 已结束；要求 read 确认；等用户输入时标 blocked |
| idle 通知刷屏/自我唤醒 | 排除 Ria；按 worker+task 30 秒节流；只匹配 working task |
| 通知投递失败 | 只 warn，不重试；worker 状态不受影响 |
| sandbox override 无法清除 | 写回原 effective mode，行为一致但可能保留同值 override |
| 暂停与在途出站竞态 | 在途一条发完即止；排队丢弃并记日志；outbox 暂停期间不发送，恢复后补发 |
| 自动暂停误判合成消息 | host_ 前缀 + source.kind=user 双重过滤；schedule 不参与 |
| 派发只调工具不写回复 | note 是工具参数硬约束：缺失/空白/超长直接报错且不投递；成功后 Host 先记录可见 turn-tail 卡片再 concludeTurn |
| command 卡片被 turn process 折叠 | 已放弃 command 事件；改用 conversation.chat.turnTail，卡片在轮次末尾独立渲染，不进入模型上下文 |
| note 卡片只存在于 Host 状态 | note 写入 ria.json（最多 100 条）；client 通过 HTTP 读取；卡片不依赖 session log，也不会进入模型上下文 |
| system prompt section 是行为约束 | 模型仍可能忽略；设置页只开关提示，不改变 worker 的 tools/preset/历史，也不做硬拦截 |
| 插件重载残留同名 section | apply 统一 dispose；按 agent id 去重；安装失败只 warn，不阻断加载 |
| 手动暂停被自动覆盖 | manual 优先；只有微信入站能清除 manual，并明确记录 resumedBy |
| 微信 note 与网页卡片看起来重复 | 预期双份：网页是卡片、微信是文本；使用同一标题语义和同一段 note 原文，不是重复推送 |
| 微信 note 发送失败或未登录 | 只 warn 或记 info 跳过；不进 outbox 重试，不影响派发和 concludeTurn |
| 微信 note 绕过暂停开关 | 统一走 deliverAssistant -> Outbound.enqueue；暂停时丢弃并记 kind=dispatch-note 日志 |
| 图片接口被误以为已实现 | wechatImage.inbound/outbound 默认 false；开关只切换预留分支，转换/发送函数明确报未实现；文本、文件、暂停路径不读取该开关 |

## 19. 总结

全局一个 Ria，PTC preset（agentPreset=ptc）+ 管理者 prompt、memory.md 和 7 个工具；模型通过 run_code SDK 调用工具；用 task 管理谁做什么，request 就是普通会话消息；通过可开关的 agent system prompt section 提供通用防误发提示（简短英文，不提具体会话），任务消息不加前缀；带 taskId 派发必须提供 note，Host 记录后由 client 在 turn 末尾显示卡片，并把同一段 note 以“📌 任务已派发”文本同步微信（带 note 的 quick relay 为“📌 消息已转交”），然后结束本轮；worker idle 时自动唤醒 Ria（只读事件、30 秒节流）；重启按 task 继续；微信客户端进程内运行，长回复/复杂 Markdown 自动转 .md 文件；推送可暂停（手动或按消息通道自动切换），暂停只停出站、连接保持；新建会话在 blank 状态显示一张 client 侧欢迎卡片（不写日志、不调用模型）；微信图片收发只预留接口，默认关闭。

## 20. 实现状态

截至当前版本：

- Phase 0–18 已实现；Phase 0–4、Phase 6、Phase 13 和 Phase 16 的 turn-tail 卡片通过隔离环境的真实 DSH 验证，其余阶段由单元测试和 smoke 覆盖。Phase 16 的截图使用手工写入 ria.json 的 note 验证渲染；真实 toolRequest 写入路径由 smoke 覆盖。
- Phase 17 的微信 note 镜像由 test/wechat.mjs 和 smoke 覆盖：task/quick 格式、暂停丢弃日志、恢复后发送、未登录跳过、发送异常不影响派发和 concludeTurn；没有用真实微信账号验证实际收件。
- Phase 18 的图片接口只是预留：test/wechat.mjs 覆盖默认关闭、开关归一化、MsgType 3 识别、图片转换明确报未实现、出站 enqueueImage 拒绝，以及默认关闭时文本路径不受影响；没有真实图片下载/上传链路。
- Phase 15 的暂停状态卡、手动开关和自动暂停轻提示没有在真实微信账号下走完整链路；弹层只在已登录时显示状态卡，隔离 profile 无法伪造成已登录。
- Phase 14 的近期 worker 记录、scope=recent 候选字段、空窗口和无 lastUsedAt 字段的 lossless 输出由 smoke 覆盖；挑选行为本身是 prompt 约束，未用真实模型验证。
- Phase 13 的设置页已在隔离 DSH 里真实点击：设置导航出现 Ria；开关默认勾选，关闭后显示“当前：已关闭”且 GET /settings 返回 false，重新打开后恢复 true；截图 docs/ui-settings.png。system prompt section 的安装、开关和空文本同时由单元测试与 smoke 覆盖。
- Phase 11 只用 mock 的 agent/status 事件验证，尚未在真实 worker 会话里触发。
- 临时 worker 权限（审批阶段二）已实现，等待用户在真实会话里首次验证。
- 微信文件发送链路已实现并用 mock 覆盖，尚未用真实微信账号完成 .md 收发验证。
- 微信暂停推送的自动切换、队列丢弃和持久化由单元测试与 HTTP smoke 覆盖；没有用真实微信账号验证暂停期间的连接保持。

文件：

- lib/index.js：Host、RiaStore（含 recentWorkers、dispatchNotes）、7 个工具、manager prompt、启动恢复、HTTP API（含 settings、dispatch-notes）、approval observer 接线、grant 接线、微信服务接线、DispatchGuard 接线。
- lib/dispatch-guard.mjs：agent 作用域静态 system prompt section 的安装、agent/created 与 disposed 监听、开关求值、dispose。
- lib/approvals.mjs：approval/request 只读观察器、pending 列表、TTL/abort/shutdown 清理。
- lib/worker-idle.mjs：agent/status 只读监听、working task executor 过滤、Ria 排除、按 worker+task 节流、配置/环境变量归一化。
- lib/grants.mjs：临时权限 set/list/reset、原值记录、task close/expiry/startup 恢复、审计、失败重试。
- lib/client.js：侧边栏入口、瞬时 launcher、入口右侧微信 chip 和登录弹层（含推送状态卡、暂停/恢复按钮、自动暂停轻提示）、设置页 Ria section、conversation.chat.turnTail 派发 note 卡片、conversation.input.dock 的 blank 欢迎卡片。
- lib/wechat/wxweb.mjs、login.mjs、outbound.mjs：复用的文件传输助手协议、扫码登录、串行发送，以及 .md 文件上传/appmsg 发送；outbound 另含只保留签名、当前 reject 的 enqueueImage。
- lib/wechat/markdown.mjs：长度/代码块/表格/标题/链接判定、配置归一化、文件名。
- lib/wechat/image.mjs：微信图片预留接口——wechatImage.inbound/outbound 归一化、MsgType 3 识别、imagePartFromMessage 签名与 TODO（当前明确报未实现）。
- lib/wechat/service.mjs：进程内连接、assistant 文本回传、派发 note 文本镜像、长回复转文件/失败回退、入站去重、Ria 投递、重连积压处理、暂停状态与按通道自动切换，以及默认关闭的图片入站预留分支（deliverImageFromWechat）。
- lib/wechat/request-ids.mjs：wx_ / host_ requestId 前缀与来源判定。
- lib/wechat/outbound.mjs：串行发送、暂停门禁、排队丢弃、在途完成。
- cordis.patch.yml：插件 patch。
- test/smoke.mjs：Host 流程 smoke；近期 worker 记录、scope=recent/sessions 字段、空窗口、失败不更新、prompt 规则与 lossless 断言；dispatch-notes 按 session/turn 过滤、错误 session 空列表、note 持久化、snapshot 读取失败仍派发；派发 note 的微信镜像调用与失败隔离。
- test/wechat.mjs：微信服务单元测试，含派发 note 的 task/quick 格式、暂停丢弃、恢复发送、未登录跳过、发送异常，以及图片接口默认关闭、开关归一化、MsgType 3 识别和预留函数报错。
- test/wechat-file.mjs：Markdown 判定、文件发送、失败回退和 multipart/appmsg 单元测试。
- test/wechat-pause.mjs：手动暂停/恢复、自动按通道切换、合成消息过滤、manual 优先级、队列竞态、丢弃日志、重启持久化。
- test/approvals.mjs：审批观察器单元测试。
- test/grants.mjs：临时权限单元测试（过期、startup、漂移跳过、恢复失败、审计）。
- test/worker-idle.mjs：正常触发、Ria 排除、非 working/running 不触发、节流、关闭开关、多 task 合并、配置归一化。
- test/startup.mjs：恢复上限、blocked 状态、更新/成功派发清零、启动异常通知。
- test/dispatch-guard.mjs：section 安装、agent/created 与 disposed、重复安装、开关文本、失败 warning、shutdown。
- docs/system-dispatch-guard.md：系统级防误发提示调研，含 DSH 注入点、对比、推荐方案和落地步骤；v0.23 已按静态 section + 设置页方案实施。
- docs/ui-settings.png：隔离 DSH 中“设置 > Ria”开关的真实界面截图。
- docs/ui-dispatch-note.png：隔离 DSH 中 Ria 会话轮次末尾的“任务已派发”卡片截图（note 为手工写入 ria.json 的验证数据）。

已验证：

- 单例 ensure；第二次 ensure 返回 created=false。
- PTC 创建；ria.json 记录 riaPreset=ptc。
- 侧边栏入口点击后打开同一 Session。
- 专用 Workspace 创建并 attach，会话界面显示工作区 Ria，输入框可用。
- GET /health、POST /ensure、GET /state 正常。
- GET /wechat/status 返回 idle；POST /wechat/login 返回 data:image/jpeg 二维码；弹层显示 190×190 二维码。
- 宽侧边栏中 chip 位于 Ria 标题右侧；折叠侧边栏不插入。
- startup 测试覆盖 recoveryCount=3 的 working task：启动后产生一条通知、任务变 blocked 并带 blockedReason，status 可见；通知包含 taskId/executor/goal；更新 task 和成功派发都会把 recoveryCount 清零；pending delivery 重试成功也不会误判为超限；resolveAgent 失败时产生启动失败通知。测试不调用模型。
- smoke 覆盖近期 worker：首次派发前 scope=recent 为空；成功 task 派发后出现 1 个候选并带 title/cwd/lastTaskId/lastTaskGoal/lastTaskStatus/lastUsedAt；quick relay 更新 lastUsedAt 且保留 lastTaskId；scope=sessions 带 title 和可选的 cwd/lastUsedAt；失败 request 不更新；ria.json 持久化 recentWorkers；所有工具输出递归检查为 lossless。
- smoke 覆盖 Workspace 挂载、7 个工具注册、request 投递、task 派发与 quick relay 都不加前缀、dispatch guard section 同时装到 worker 和 Ria、GET/POST /settings 与 GET /state 的 settings、status、read、memory、持久化，以及新建 Ria 不写任何 session 事件、第二次 ensure 不重复；dispatch-guard 测试覆盖安装、created/disposed、重复安装、开关文本、失败 warning、shutdown；wechat 测试覆盖文本提取、事件过滤、入站去重/回显过滤、失败标记、reconnect skip、状态视图，以及图片接口预留（默认关闭、开关归一化、MsgType 3 识别、转换/出站明确报未实现，且默认关闭时文本路径不变）；approvals 测试覆盖活跃 executor 过滤、始终 next()、abort/TTL/shutdown 清理和 lossless 输出；grants 测试覆盖授权门槛、原值记录、task done 自动恢复、显式 reset、过期、startup、漂移跳过、恢复失败和审计；wechat-file 测试覆盖阈值/代码块/表格/标题/链接、配置/env、文件名、短消息不变、长消息发 .md、失败回退，以及上传和 appmsg 字段；wechat-pause 测试覆盖手动开关与持久化、非微信自动暂停、微信自动恢复、host_/schedule 过滤、manual 不被 channel 覆盖、暂停时不发送、排队丢弃而在途完成、恢复后补发 outbox，以及日志字段。npm test 九个测试全部通过。
- 新建 Ria 后真实 Web UI 在输入框上方显示欢迎卡片（blank 状态），发出第一条消息后消失；没有浏览器 runtime error。修复后的 Ria 会话日志通过 v4 校验（restoreReleasedV4Artifact：VALID，264 个事件），隔离 DSH 重启并重新打开 Ria 不再出现 corrupt。
- 真实 Web UI 中 task 派发的 note 渲染在轮次末尾：DOM 有 [data-ria-dispatch-note="task"]，标题“任务已派发”，位于轮次末尾；无 runtime error；截图 docs/ui-dispatch-note.png。真实 ria_request 写入路径由 smoke 覆盖。
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
- .md 文件发送失败回退文本时，若文本仍超过 4 块，会按原有文本切块策略截断。
- 恢复上限在启动时判定；如果给 Ria 的通知本身发送失败，只记录日志，任务仍会保持 blocked，等待用户或下次启动处理。
- 微信暂停 UI 只在 chip 弹层已登录时出现；自动暂停提示依赖 2 秒/15 秒轮询，最迟约 15 秒才在侧边栏出现。真实微信账号未验证暂停期间的连接保持。
- 暂停不能撤回已经在发送中的那一条；只保证后续排队消息不发出。
- 近期 worker 只记录 Ria 成功派发过的会话；用户手工使用不计入。挑选是 prompt 约束，Host 不强制，也未用真实模型验证是否符合预期。
