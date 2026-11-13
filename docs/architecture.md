# Ria 顶层设计

> 一页读懂当前系统：边界、对象、流程与可靠性。用户用法见 [README.md](../README.md)，历史设计与细节见 [DESIGN.md](../DESIGN.md)。

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

Ria（阿汐）是一个全局唯一的顶层 DSH Session，不是 subagent，也不是多 Agent 编排器。她以 PTC preset 运行，模型只直接看到 `run_code` 和生成的 SDK；12 个 `ria_*` 工具通过 SDK 注册。她的职责是**管理任务，不是替 worker 干活**：

1. 听懂需求，不清楚就先问；
2. 把可执行部分写成工单，定义验收标准；
3. 派给已有或新建的顶层 worker；
4. 等 worker 停下，读取结果；
5. 向用户汇报，或在需要拍板时停下来问。

executor 要么是 worker 的 sessionId，要么是 `self`：Ria 默认把任务转交 worker；用户明确说“你来做”时，executor 取 `self`（也是 `ria_resolve` 的缺省值）。一条真实用户消息恰好有一个归宿：被回答、变成工单、并入已有工单、执行控制操作，或显式阻塞等用户；不存在“消息悄悄消失”。

不做的部分：

- 不轮询 worker 进度，不维护独立 bridge，不额外占端口；只监听宿主事件与 worker idle。
- 不替用户批准 worker 的权限请求，只把审批暴露给用户；不自动放宽 worker 权限。
- 不把 subagent 当 worker；派发目标必须是顶层会话。
- 不写 transcript；Ria 与 worker 的会话日志仍由 DSH 管理。

## 2. 核心对象

### 工单

工单是耐久的工作单元，存放在 `ria.json`。八个状态：

| 状态 | 含义 | 默认 waitingOn |
|---|---|---|
| `intake` | 每条真实用户消息由 Host 自动登记，等 Ria 定性；只有 intake 能被 `ria_resolve` 定性，且只能一次 | `ria` |
| `open` | 已定性，等 Ria 派发；有依赖时等依赖 | `ria` |
| `working` | 已投递给 worker，等这一轮结束 | `worker` |
| `blocked` | 等用户回答、审批或环境恢复；不自动续跑 | `user` |
| `forked` | 分叉容器，等子工单；P1 预留，当前 `split` 返回 `not_supported` | `children` |
| `done` | 完成；`resolution.kind` 可为 answered、merged、control 等 | `none` |
| `failed` | 失败，保留 `failure` | `none` |
| `cancelled` | 用户或级联取消 | `none` |

`done` / `failed` / `cancelled` 是终态，但都可以 reopen 回 `open`；历史与 revision 保留。

- **executor**：`self` 或一个顶层 worker 的 sessionId；一个工单同一时间只有一个 executor。
- **waitingOn**：`ria`、`worker`、`user`、`approval`、`environment`、`children`、`dependency`、`none`。它回答“现在卡在谁”。
- **dependsOn**：最多 8 个上游，DAG，可跨 root。未全部 `done` 时工单停在 `open + waitingOn=dependency`，不可派发；上游 `failed`/`cancelled` 不自动跳过，写 `dependencyAlerts` 并告警。全部 `done` 后写 `readyAt`，生成 `queueToken = ticketId:readyAt:revision`。token 不入库，派发时校验，保证一次就绪最多派发一次。
- **checklist**：有序步骤，最多 50 条；status 与看板显示 `done/total`；终态后视为最终结果，不再改勾。
- **attention**：结构化等待项 `{kind, question, options?}`；`blocked + user` 放问题与选项，`blocked + approval` 放审批引用。审批本身由独立的只读观察器处理，不由 Ria 批准。
- **revision / history**：每次状态变更 revision 递增，按 revision 做乐观并发；非法转移返回 `invalid_transition`，不静默改写。只有 `RiaStore.transitionTicket` 能改 status，22 条不变量在写入时校验。

## 3. 主流程

```text
用户消息
  │ Host: agent/pre-step 登记
  ▼
intake ──ria_resolve──▶ open ──ria_request 预检──▶ working
                                                     │ worker turn 结束
                                                     ▼
                              [Worker idle] ◀── agent/status = idle
                                                     │
                                                     ▼
                              ria_read ──▶ done / blocked / 续跑
```

1. **登记**：Host 只在 `agent/pre-step` 捕获 `source.kind=user` 且非 host 的消息，自动建 root `intake`，并在同一 turn 注入 `[Task intake]`（`source.kind=ria-task-host`，不会被再次捕获）。
2. **定性**：Ria 调 `ria_resolve`，把 intake 收敛为 answered、work、merge、control 或 blocked。每个 intake 只能定性一次；`ria_ticket` 不能改 intake。
3. **派发**：work 生成工单并指定 executor；`ria_request` 先做预检：会话存在、是顶层、未归档、cwd 可用、目标匹配 executor、依赖 token 有效、附件与模型支持。
4. **执行**：worker 收到的是一条普通用户消息，不加任务前缀；防误发提示由 system prompt section 提供。
5. **唤醒**：worker 的 `agent/status` 变为 idle，且它正是一个 `working` 工单的 executor 时，Host 向 Ria 发 `[Worker idle]`。通知 30 秒节流、排除 Ria 自己，只带最后 turn 与 end reason，不代表任务成功。
6. **收口**：Ria 先 `ria_read` 看 worker 的最后输出，再决定 `done`、`blocked`，或补充信息继续派发。worker turn 以 `aborted(user)` 结束时，工单自动转 `blocked`，Ria 必须停下来问用户，不自行续跑。

兜底：未定性的 intake 在 `agent/turn-stopping` 先被 steer 提醒一次，第二次仍未定性就自动 `blocked`；`agent/turn/end` 时，`aborted(user)` 会把未定性 intake 收敛为 `cancelled`，error 落 `blocked`，其余留给重启恢复。

## 4. 可靠性

### 4.1 派发前预检

目标会话不存在、是 subagent、已归档、cwd 不可用、executor 不匹配、依赖未就绪、附件缺失或模型不支持图片，都会在产生任何副作用之前失败：不投递、不写 recentWorkers、不动工单。

### 4.2 真实消息与副作用分开

真正的 Session 消息先写 pending delivery，prompt 被接受后删除；失败则保留，重启或下次 ensure 按原 requestId 重试。

派发卡片、微信镜像、queue wake、恢复与 blocked 提示属于“消息已派发之后”的副作用，统一进 `outbox.json`，由独立投递器（`lib/outbox.mjs`）执行：

- 至少一次；按 kind + ticketId + note + turn 生成幂等键。
- 退避 10s / 1m / 5m / 15m / 1h，最多 6 次；失败保留，delivered 保留 24 小时，队列上限 500。
- 每 30 秒 pump 一次，startup 与 turn-start 补投。

outbox 与 `ria.json` 不是同一个事务：派发已被接受、但 outbox 尚未落盘时崩溃，仍是已知窗口。

### 4.3 重启恢复

启动时只恢复 `intake`、`open`、`working`；`forked` 递归恢复子工单，`blocked` 不自动续跑。每个工单最多恢复 3 次，超过则转 `blocked` 并标 `recovery_exhausted`。pending request 按原 requestId 重试；startup 只向 Ria 发一条恢复提示，避免重复唤醒。

### 4.4 审批可见性

插件只读监听 `approval/request`：若等待审批的是某个活跃工单的 executor，就把工单迁到 `blocked + waitingOn=approval`，写 attention，并立即 `next()` 把决定权交回原有 UI answerer。插件从不批准或拒绝。审批结束、abort 或 15 分钟 TTL 到期后，工单从 `blocked` 经 `open` 回到 `working`；重启时清理已失效的审批引用，避免永久卡住。

### 4.5 依赖与忙碌

依赖全部完成时，`queue_wake` 经 outbox 叫醒 Ria；`ria_request` 校验 `queueToken`，未就绪或 token 过期返回 `ticket_not_ready`。目标 worker 正在跑 turn 或已有 pending 队列时，`mode=queue` 返回 `worker_busy`；`mode=steer` 只用于同步信息，不下发新任务。

### 4.6 归档与写入

终态工单在写入成功后从热存移入 `tickets.log.jsonl`，同时按月写 `tickets-YYYY-MM.jsonl`（保留 12 个月）。热存保留所有非终态，加上最近 24 小时或最新 50 条终态；读取端合并两边，按 `ticketId + closedAt` 去重。`ria.json`、`outbox.json`、`memory.md` 都用 mutex + 临时文件 + fsync + rename 原子写，权限 0600。

## 5. 持久化

`stateDir` 默认为 `DSH_HOME/state/ria/`。

| 文件 / 目录 | 职责 |
|---|---|
| `ria.json` | 热状态 schema v4：Ria session、tickets、pending deliveries、recentWorkers、grants、settings、dispatchNotes、feedback |
| `outbox.json` | 副作用待投递 / 失败 / 已送达记录；独立于 ria.json |
| `tickets.log.jsonl` | 终态工单归档；按月文件保留 12 个月 |
| `memory.md` | 稳定偏好，≤4 KB，0600 |
| `reflections/` | 每日反省的 notes；P2 wiki 也规划在这里（尚未实现） |
| `wechat-inbound/` / `wechat-claw-inbound/` | 微信入站图片原图；30 天 / 500 个上限 |
| `wechat/`、`wechat-claw/`、`qq-bot/` | 各通道凭据、游标与暂停状态 |
| `audit.jsonl` | 临时权限（grant）审计 |

不保存聊天 transcript；原始会话日志在 DSH 的 `sessions` 下。

## 6. 通道与界面

- **Web GUI**：侧栏 Ria 入口；派发确认渲染在 Ria 当前轮次末尾的卡片；设置页控制 dispatchGuard 等开关；通道面板负责扫码登录与暂停。
- **微信 Claw**：直连 iLink 机器人接口，入站文本与图片，出站文本与本机图片。
- **QQ 机器人**：扫码绑定后用官方 SDK 的 WebSocket 网关收发文本。
- **微信「文件传输助手」**：网页版协议，入站文本与图片，出站文本、`.md` 文件与本机图片。
- 三个通道都在 DSH 进程内运行，不启动 bridge、不额外占端口；凭据只存本机。

任务看板是只读的全屏浮层，不写工单、不派发消息：横轴按创建时间、每 3 张一列；纵轴按 worker 所属 workspace 分成水平泳道；跨泳道依赖只画箭头。筛选只灰化不匹配的卡片（opacity 0.36），单击卡片复制 ticketId，悬停高亮整条上下游链并显示详情。默认加载最新 60 张，向左滚动按 `before` 分页；数据合并热存与归档。

## 7. 记忆与反省

`memory.md` 只放稳定偏好与长期约定，由 `ria_memory` 显式读写，上限 4 KB；不抄工单状态、时间戳或逐轮流水。每日反省是另一层（设计中，尚未实现）：计划每天 23:40（Asia/Shanghai）做一次 Dreaming 式离线对账，读当天的工单、turn 与 outbox，把日报写到 `reflections/YYYY-MM-DD.md`，只提议隐性规则，不自动改写记忆；P2 再考虑 wiki。

## 8. 扩展点

- **新增工具**：在 `lib/index.js` 的工具注册处加定义与实现，补 manager prompt 与测试；输出必须是 lossless JSON。
- **新增通道**：在进程内实现登录、入站、出站与暂停，凭据放 `stateDir`，入站消息转成 Ria 的普通用户消息；不新增端口。
- **改状态机**：改 `lib/tickets.mjs` 的状态、转移表与不变量，保持 `RiaStore.transitionTicket` 是唯一写入口，并同步 `docs/task-model-design.md` 与测试。
- **新增副作用**：在 outbox 增加 kind 与幂等键，明确重试与失败保留语义。
- **新增持久化字段**：升 `ria.json` schema 版本，写迁移与备份，读取端兼容旧版本。

## 9. 文档分工

README 讲用户怎么用；DESIGN.md 记录历史设计、取舍与实现细节；本文是当前系统的顶层地图；`docs/` 下的专题文件展开单个主题。代码与测试是最终事实；行为变化时，先更新这张地图，再把原因补进 DESIGN.md。
