# Ria 软件架构设计

> 一页读懂当前系统：边界、对象、流程与可靠性。用户用法见 [README.md](../README.md)。
>
> **架构提示：** 插件只运行当前架构（Chat / Advisor / Router / Executor）。旧版单会话 manager 已移除，代码与测试为准。

## 目录

- [1. 定位与边界](#1-定位与边界)
- [2. 核心对象](#2-核心对象)
- [3. 主流程](#3-主流程)
- [4. 可靠性](#4-可靠性)
- [5. 持久化](#5-持久化)
- [6. 通道与界面](#6-通道与界面)
- [7. 记忆与反省](#7-记忆与反省)
- [8. 扩展点](#8-扩展点)
- [9. 文档分工](#9-文档分工)

## 1. 定位与边界

Ria（阿汐）是一个全局唯一的顶层 DSH Session，不是 subagent，也不是多 Agent 编排器。她以 PTC preset 运行，模型只直接看到 `run_code` 和生成的 SDK；15 个 `ria_*` 工具通过 SDK 注册。她的职责是**管理任务，不是替 executor 干活**：

1. 听懂需求，不清楚就先问；
2. 把可执行部分写成工单，定义验收标准；
3. 派给已有或新建的顶层 executor；
4. 等 executor 停下，读取结果；
5. 向用户汇报，或在需要拍板时停下来问。

executor 要么是 executor 的 sessionId，要么是 `self`：Ria 默认把任务转交 executor；用户明确说“你来做”时，executor 取 `self`（也是 `ria_resolve` 的缺省值）。一条真实用户消息恰好有一个归宿：被回答、变成工单、并入已有工单、执行控制操作，或显式阻塞等用户；不存在“消息悄悄消失”。

不做的部分：

- 不轮询 executor 进度，不维护独立 bridge，不额外占端口；只监听宿主事件与 executor idle。
- 默认按风险代批 executor 的权限请求：低风险只放行本次调用，高风险只能转给用户或拒绝；只有在用户明确要求时才通过 `ria_grant` 调整会话权限；纯降权永久，任何提权都必须带 TTL 并自动恢复，从不自动放宽。
- 不把 subagent 当 executor；派发目标必须是顶层会话。
- 不写 transcript；Ria 与 executor 的会话日志仍由 DSH 管理。

## 2. 核心对象

### 工单

工单是耐久的工作单元，存放在 `ria.json`。八个状态：

| 状态 | 含义 | 默认 waitingOn |
|---|---|---|
| `intake` | 每条真实用户消息由 Host 自动登记，等 Ria 定性；只有 intake 能被 `ria_resolve` 定性，且只能一次 | `ria` |
| `open` | 已定性，等 Ria 派发；有依赖时等依赖 | `ria` |
| `working` | 已投递给 executor，等这一轮结束 | `executor` |
| `blocked` | 等用户回答、审批或环境恢复；不自动续跑 | `user` |
| `forked` | 分叉容器，等子工单；P1 预留，当前 `split` 返回 `not_supported` | `children` |
| `done` | 完成；`resolution.kind` 可为 answered、merged、control 等 | `none` |
| `failed` | 失败，保留 `failure` | `none` |
| `cancelled` | 用户或级联取消 | `none` |

`done` / `failed` / `cancelled` 是终态，但都可以 reopen 回 `open`；历史与 revision 保留。

- **executor**：`self` 或一个顶层 executor 的 sessionId；一个工单同一时间只有一个 executor。
- **waitingOn**：`ria`、`executor`、`user`、`approval`、`environment`、`children`、`dependency`、`none`。它回答“现在卡在谁”。
- **dependsOn**：最多 8 个上游，DAG，可跨 root。未全部 `done` 时工单停在 `open + waitingOn=dependency`，不可派发；上游 `failed`/`cancelled` 不自动跳过，写 `dependencyAlerts` 并告警。全部 `done` 后写 `readyAt`，生成 `queueToken = ticketId:readyAt:revision`。token 不入库，派发时校验，保证一次就绪最多派发一次。
- **checklist**：有序步骤，最多 50 条；status 与看板显示 `done/total`；终态后视为最终结果，不再改勾。转 done/cancelled 时若仍有未勾项，默认拒绝（checklist_pending）；只有显式 waiver 才放行，并把 waiver、未完成项与豁免时间一并写进 resolution，所有收口路径（含 cascade、merge、resolveIntake、父工单自动收口）走同一门禁。
- **attention**：结构化等待项 `{kind, question, options?}`；`blocked + user` 放问题与选项，`blocked + approval` 放审批引用。审批默认由插件按风险规则加 Ria 裁决处理；Ria 只能放行本次调用，不能改持久权限。
- **revision / history**：每次状态变更 revision 递增，按 revision 做乐观并发；非法转移返回 `invalid_transition`，不静默改写。只有 `RiaStore.transitionTicket` 能改 status，22 条不变量在写入时校验。

## 3. 主流程

```text
用户消息
  │ Host: agent/pre-step 登记
  ▼
intake ──ria_resolve──▶ open ──ria_request 预检──▶ working
                                                     │ executor turn 结束
                                                     ▼
                              [Executor idle] ◀── agent/status = idle
                                                     │
                                                     ▼
                              ria_read ──▶ done / blocked / 续跑
```

1. **登记**：Host 只在 `agent/pre-step` 捕获 `source.kind=user` 且非 host 的消息，自动建 root `intake`，并在同一 turn 注入 `[Task intake]`（`source.kind=ria-task-host`，不会被再次捕获）。
2. **定性**：Ria 调 `ria_resolve`，把 intake 收敛为 answered、work、merge、control 或 blocked。每个 intake 只能定性一次；`ria_ticket` 不能改 intake。
3. **派发**：work 生成工单并指定 executor；`ria_request` 先做预检：会话存在、是顶层、未归档、cwd 可用、目标匹配 executor、依赖 token 有效、附件与模型支持。
4. **执行**：executor 收到的是一条普通用户消息，不加任务前缀；防误发提示由 system prompt section 提供。
5. **唤醒**：executor 的 `agent/status` 变为 idle，且它正是一个 `working` 工单的 executor 时，Host 向 Ria 发 `[Executor idle]`。通知 30 秒节流、排除 Ria 自己，只带最后 turn 与 end reason，不代表任务成功。
6. **收口**：Ria 先 `ria_read` 看 executor 的最后输出，再决定 `done`、`blocked`，或补充信息继续派发。executor turn 以 `aborted(user)` 结束时，工单自动转 `blocked`，Ria 必须停下来问用户，不自行续跑。

兜底：未定性的 intake 在 `agent/turn-stopping` 先被 steer 提醒一次，第二次仍未定性就自动 `blocked`；`agent/turn/end` 时，`aborted(user)` 会把未定性 intake 收敛为 `cancelled`，error 落 `blocked`，其余留给重启恢复。

## 4. 可靠性

### 4.1 派发前预检

目标会话不存在、是 subagent、已归档、cwd 不可用、executor 不匹配、依赖未就绪、附件缺失或模型不支持图片，都会在产生任何副作用之前失败：不投递、不写 recentExecutors、不动工单。

### 4.2 真实消息与副作用分开

真正的 Session 消息先写 pending delivery，prompt 被接受后删除；失败则保留，重启或下次 ensure 按原 requestId 重试。

派发卡片、微信镜像、queue wake、恢复与 blocked 提示属于“消息已派发之后”的副作用，统一进 `outbox.json`，由独立投递器（`lib/outbox.mjs`）执行：

- 至少一次；按 kind + ticketId + note + turn 生成幂等键。
- 退避 10s / 1m / 5m / 15m / 1h，最多 6 次；失败保留，delivered 保留 24 小时，队列上限 500。
- 每 30 秒 pump 一次，startup 与 turn-start 补投。

outbox 与 `ria.json` 不是同一个事务：派发已被接受、但 outbox 尚未落盘时崩溃，仍是已知窗口。

### 4.3 重启恢复

启动时只恢复 `intake`、`open`、`working`；`forked` 递归恢复子工单，`blocked` 不自动续跑。每个工单最多恢复 3 次，超过则转 `blocked` 并标 `recovery_exhausted`。pending request 按原 requestId 重试；startup 只向 Ria 发一条恢复提示，避免重复唤醒。

### 4.4 审批自动化

插件监听 `approval/request`，用 `lib/approval-policy.mjs` 对缓存的工具参数做保守分类。监听器以 `prepend` 注册：宿主 web bundle 先加载的 `dsh-api-remotes` 会把审批转发给浏览器并等用户点击，且不调用 `next()`；普通注册（append）会让转发器先拿到请求，Ria 永远收不到。prepend 后 Ria 先判断自己的 active 工单，不匹配再用 `next()` 放回宿主原生 UI。低风险直接返回 `allowed-once`（仅本次），硬拒绝直接 `rejected`；中/高风险把工单迁到 `blocked + waitingOn=approval`，写 attention，唤醒 Ria，并等待 `ria_approval_decision`。Ria 只能 allow 中/低风险；高风险只能 `ask-user` 或 `deny`。2 分钟无决定、唤醒失败或审计失败一律按拒绝处理并通知用户。`ask-user` 调用宿主原生 UI，用户的结果同样入审计。审批结束、abort 或 TTL 到期后，工单从 `blocked` 经 `open` 回到 `working`；重启时清理已失效的审批引用，避免永久卡住。关闭设置开关后回到只读观察 + 原生 UI 的旧行为。到达但未归 Ria 处理的请求会向 `approval-diagnostics.jsonl` 写一行 `{event:"approval_unhandled",reason,agentId,toolName,callId?}`，用于排查「executor 有 approval/asked、Ria 侧却没有任何记录」。

### 4.5 依赖与忙碌

依赖全部完成时，`queue_wake` 经 outbox 叫醒 Ria；`ria_request` 校验 `queueToken`，未就绪或 token 过期返回 `ticket_not_ready`。目标 executor 正在跑 turn 或已有 pending 队列时，`mode=queue` 返回 `executor_busy`；`mode=steer` 只用于同步信息，不下发新任务。

### 4.6 归档与写入

终态工单在写入成功后从热存移入 `tickets.log.jsonl`，同时按月写 `tickets-YYYY-MM.jsonl`（保留 12 个月）。热存保留所有非终态，加上最近 24 小时或最新 50 条终态；读取端合并两边，按 `ticketId + closedAt` 去重。`ria.json`、`outbox.json`、`memory.md` 都用 mutex + 临时文件 + fsync + rename 原子写，权限 0600。

### 4.7 可观测性与兜底边界

三条原则，按优先级排列，约束所有「怎么发现卡住 / 在等什么」的设计。

1. **不做定时看门狗或轮询来发现会话卡死。** 卡住必须由状态机自己的事件表达，而不是由旁路进程按固定间隔去猜。
   理由：轮询只能证明「没有新事件」，分不清是在等审批、在跑长任务，还是在跑死循环；它把「没建模」藏起来，用误报和额外 turn 换虚假的安全感。宿主已经给出 `turn/start`、`turn/end`、`approval/asked`、`approval/decided` 这些事实源（见 4.4），缺的是把它们接进工单状态，而不是再加一个观察者。

2. **ticket 机制必须完整自洽。** 状态迁移、阻塞原因、审批等待都要显式建模：可观测（状态与原因可查询）、可通知（变化主动推给 Ria 或用户）、可恢复（知道在等谁、等什么、下一步做什么）。任何「人正好看见才发现」的路径都算缺陷。
   理由：核心原则要求「有始有终」——做完有结果，失败有原因，卡住说明在等谁。若阻塞只能靠人肉发现，这条承诺就是空的；更糟的是未建模的阻塞会同时骗过 Ria、看板和用户：三处都显示 `working`，实际卡在审批上。

3. **发现遗漏时修根因，不加轮询兜底。** 复盘/反思发现盲区，先回答「状态机为什么没覆盖它」，补事件、补迁移、补通知，再用测试锁住；不把「加一个定时提醒」当作修复。
   理由：兜底会把 bug 固化成特性——掩盖真实状态、引入延迟与不一致，并让下一次复盘看不到原始症状。只有根因本身不可建模（外部依赖不可观测）时才允许兜底，且必须在文档里写明它掩盖了什么、代价是什么。

判定顺序：先问状态机缺哪个事件，再问要不要加定时器；如果答案是「缺事件」，就不准加定时器。

## 5. 持久化

`stateDir` 默认为 `DSH_HOME/state/ria/`。

| 文件 / 目录 | 职责 |
|---|---|
| `ria.json` | 热状态 schema v5：Ria session、tickets、pending deliveries、recentExecutors、grants、settings、dispatchNotes、feedback |
| `outbox.json` | 副作用待投递 / 失败 / 已送达记录；独立于 ria.json |
| `tickets.log.jsonl` | 终态工单归档；按月文件保留 12 个月 |
| `memory.md` | 稳定偏好，默认 2400 字符 / 12 条 / 单条 300，0600；超出归档到 `memory-archive/<slug>.md`（不注入） |
| `reflections/` | 定期反思的 notes 与运行账本；P2 wiki 也规划在这里（尚未实现） |
| `wechat-inbound/` / `wechat-claw-inbound/` | 微信入站图片原图；30 天 / 500 个上限 |
| `wechat/`、`wechat-claw/`、`qq-bot/` | 各通道凭据、游标与暂停状态 |
| `audit.jsonl` | 会话权限（grant）与审批决定审计 |
| `approval-diagnostics.jsonl` | 到达但未归 Ria 处理的 approval/request 诊断（agentId、toolName、callId、reason） |

不保存聊天 transcript；原始会话日志在 DSH 的 `sessions` 下。

## 6. 通道与界面

- **Web GUI**：侧栏 Ria 入口；派发确认渲染在 Ria 当前轮次末尾的卡片；设置页控制自动暂停、审批代批、反思、说话风格与记忆等选项；通道面板负责扫码登录与暂停。
- **微信 Claw**：直连 iLink 机器人接口，入站文本与图片，出站文本与本机图片。
- **QQ 机器人**：扫码绑定后用官方 SDK 的 WebSocket 网关收发文本。
- **微信「文件传输助手」**：网页版协议，入站文本与图片，出站文本、`.md` 文件与本机图片。
- 三个通道都在 DSH 进程内运行，不启动 bridge、不额外占端口；凭据只存本机。

任务看板是只读的全屏浮层：横轴按项目（executor 所属 workspace），项目内是主题卡瀑布；主题弹窗用二维网格展示工单与依赖。看板不建工单、不派发、不唤醒 executor；工作区表头与主题卡各有一个「说」输入框，只把带工作区或主题来源标注的用户消息以 queue 模式发给 Ria，之后仍由 Ria 正常派发。顶部统计按「数量（活跃 X · 阻塞 Y）」显示项目/主题/工单；工单提交后由同源 SSE `/board/events` 推送变更，看板去抖后自动刷新并保留滚动位置和筛选；筛选只灰化不匹配的卡片。悬停工单卡只显示单号、状态、执行者和更新时间的精简浮层，底部可复制单号或打开 executor；单击工单卡（包括卡内执行者名字）打开详情弹窗，弹窗按需读取 `GET /board/ticket` 的「最后结果」，长清单和完整字段都在这里。

## 7. 记忆与反省

`memory.md` 只放稳定偏好与长期约定，由 `ria_memory` 显式读写；默认上限 2400 字符 / 12 条 / 单条 300（warn 阈值 2160 / 11 / 270），超限拒绝写入，长内容归档到 `memory-archive/<slug>.md`（不注入）；不抄工单状态、时间戳或逐轮流水。定期反思已实现：设置页可开启每天/每周的 schedule，到点后 Ria 启动一个独立的只读 executor（只有 6 个 `ria_reflect_*` 工具），读当天/当周的工单、turn 与 outbox（会话默认 `summary`，异常再按 `ref`/窗口 `full` 定点读），把报告写到 `reflections/YYYY-MM-DD.md`；executor 只提议隐性规则，不自动改写记忆。报告在写入草稿前就跑与 finish 相同的校验，失败不落盘；Ria 也可用 `ria_reflect action=validate` 先验后写。每次 dispatch 自动在固定主题「记忆与反思」下建一张监控工单（executor=本次反思 executor，status=working，run.json 记 watchTicketId）；finish 把它置 done 并写 reportPath/bytes，abort 置 cancelled，报告失败/超时置 blocked 并写原因；重启恢复会跳过这类监控单。报告渲染/归档 UI、多天回填与 P2 wiki 尚未实现。

## 8. 扩展点

- **新增工具**：在 `lib/index.js` 的工具注册处加定义与实现，补 manager prompt 与测试；输出必须是 lossless JSON。
- **新增通道**：在进程内实现登录、入站、出站与暂停，凭据放 `stateDir`，入站消息转成 Ria 的普通用户消息；不新增端口。
- **改状态机**：改 `lib/tickets.mjs` 的状态、转移表与不变量，保持 `RiaStore.transitionTicket` 是唯一写入口，并同步相应测试。
- **新增副作用**：在 outbox 增加 kind 与幂等键，明确重试与失败保留语义。
- **新增持久化字段**：升 `ria.json` schema 版本，写迁移与备份，读取端兼容旧版本。

## 9. 文档分工

README 讲用户怎么用；本文是当前系统的顶层地图。代码与测试是最终事实；行为变化时，先更新这张地图，再把原因补进对应文档或 commit。
