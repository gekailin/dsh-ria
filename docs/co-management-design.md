# 协管（co-management）设计（P1+P2 已实现）

> 与 [design-v2.md](design-v2.md) 配套阅读。P1+P2 已按简化口径落地：与 direct 无耦合、无 smart-route；`co-management.json` 只存 transport 状态。

## 背景与现状

根 DESIGN.md 第 5 条要求阿汐能以无侵入方式协管常规会话：不改原上下文，派发任务、查询进展、获取结果。现在只有临时能力：

- Chat 提示词里让模型用 `chatbot_sessions` 找会话、`chatbot_read` 读后续；给会话派活一律走 ticket（co-managed 执行者），不再有直接发消息的 talk 通道；
- 没有「协管范围」的持久状态，跨轮次不记得用户在跟踪谁；
- 没有事件监控：目标会话的回复、提问、提权审批都不会主动到达 Chat/用户；
- 与直通（direct）**无耦合**：协管用独立状态/去重，不与 direct 共享或仲裁。

结果是：用户说“帮我盯着这个会话”，Ria 只能当下读一次，之后靠用户再问。

## 目标 / 非目标

**目标**

1. 用户说「协管 / 关注 / 跟踪 / 盯着 xxx」后，把该常规会话纳入**持久**协管范围。
2. 纳入后事件驱动地处理：回复转述、提问转达、提权审批走风险分级。
3. 用户对协管会话说的话，转成普通用户消息发给它；可选 smart-route（默认关）。
4. 与 direct 明确分工、可同时开启且不重复转述。
5. 去重、限流、失败可见，不刷屏、不静默丢。
6. 分阶段实现、可回滚，不改目标会话的任何配置。

**非目标**

- 不接管目标会话，不替它做决定。
- 不改目标会话的 preset / tools / MCP / 模型 / 上下文。
- 不把协管会话变成直管 Worker 或 ticket。
- 不做跨机器、不做多用户广播。
- 不引入轮询或看门狗。

## 1. 概念与边界

**协管 = Chat 仍在场的「监控 + 转述 + 路由」。** Chat 不退出；它订阅目标会话的事件，把该让用户知道的部分转述回来，并在用户发话时把话带过去。

| 能力 | 谁在对话 | 入站消息去往 | 事件处理 | 典型用途 |
|---|---|---|---|---|
| 协管（watch） | Chat 在场 | 用户对 Chat 说，Ria 再转给目标 | 回复转述 / 提问转达 / 审批走风险分级 | 「帮我盯着这个会话」 |
| 直通（direct） | Chat 退出该通道 | 用户消息**全部**直接进目标会话 | 只转发目标回复（【直通·标题】） | 「接下来我直接和它聊」 |
| ticket | Chat + Advisor + Worker | 变成工单，由 Worker 执行 | Advisor 出 WorkOrder、Worker 报告 | 有验收的正式工作 |
| 独立 worker 观察 | Ria 只读 | 用户直接指挥该 worker | 只读观察、给建议，不转述不路由 | 了解进度、提效建议 |

三条硬边界（沿用 [worker-observability.md](worker-observability.md) 的「观察 ≠ 指挥」）：

- **不接管**：协管不成为第二个指挥者，不替目标会话排优先级、不催它、不打断它。
- **不改配置**：只发普通用户消息；不写它的 preset/tools/MCP/模型/上下文，不写任何会话配置。
- **不替它做决定**：提问转给用户回答；提权审批走风险策略（用户显式配置的策略才算授权），协管本身不批准。

## 2. 状态模型

独立文件 `stateDir/co-management.json`（0600，tmp+fsync+rename 原子写），**不放 v2.json**：

- v2.json 已经被 ticket/绑定/WorkOrder/候选/审批元数据高频写；协管的增删与它们的写路径无关，混在一起只会放大「最后写入者覆盖」。
- 独立文件可单独备份/删除即回滚；SQLite 迁移（见 [sqlite-migration-design.md](sqlite-migration-design.md)）后再并入数据库表。

条目 schema（示意）：

```text
{
  "version": 1,
  "watches": [
    {
      "watchId": "watch_<time36>_<rand>",
      "sessionId": "session-…",
      "titleSnapshot": "Alpha Session",
      "addedAt": 1795…, "addedBy": "chat",
      "status": "active | paused | stale | revoked",
      "options": {
        "relayReplies": true,
        "relayQuestions": true,
        "rateLimit": { "maxPerMin": 6, "mergeWindowMs": 5000, "windowMs": 60000 }
      },
      "cursors": { "lastRelayedSeq": 1234, "lastUserSeq": 1234 },
      "stats": { "relayed": 0, "suppressed": 0, "lastRelayAt": 0 }
    }
  ]
}
```

- **重启保留**：进程启动时加载该文件，watch 继续生效；从 `lastRelayedSeq` 继续，**不回放历史**（避免重启后的补发风暴）。
- **与 workspace/权限解耦**：协管不含 sandbox、approval policy、cwd 任何字段；目标会话的权限只由它自己的配置与审批策略决定。
- **上限**：默认最多 20 个 active watch；超出拒绝 add 并提示先移除。
- **生命周期**：`active` → 用户暂停/取消 → `paused` / `revoked`（保留 24h 供审计与列表展示，之后清理）；会话不存在/归档 → `stale`，通知用户后可恢复或移除。

## 3. 事件表与处理策略

| 事件 | 来源 | 默认动作 | 去重键 | 备注 |
|---|---|---|---|---|
| `assistant/message`（正式文本） | session/event | **转述**，前缀 `【协管·<标题>】` | `sessionId:seq` | 合并窗口 + 速率上限；工具调用/参数不转述 |
| `user-questions/request` / `ask_user_question` pending | waterfall / 会话事件 | **转达问题**给用户，保存 pending；不自动回答 | `questionId` / `callId` | 用户回答后以普通消息回传（§4）；超时可配置为提醒或放弃 |
| `approval/request` | waterfall | **风险分级**（复用 `lib/v2/risk.mjs`）：low 自动 `allowed-once` + 通知；medium/high/unknown 交宿主 UI 并通知 | `approvalId` | 不因协管绕过审批；决策写 `audit.jsonl`（reason=watch-risk） |
| `user/message` | session/event | **观测用户直连**：过滤 `host_` 注入，记录摘要与 `lastUserSeq` 并通知 Chat | `sessionId:seq` | 不重复派活；Ria 已知悉用户直接交代 |
| `turn/end` / error | session/event | 默认**不进频道**；不转述 | `sessionId:turn` | 错误不刷屏 |
| session 归档/删除/不可用 | list/state 查询 | 标 `stale` + 通知一次 | `sessionId` | 只在事件/命令触发时判定，不轮询 |

规则：

- **同一事件只转述一次**：写入 `cursors.lastRelayedSeq`，跨重启沿用（不回放）。
- 提问与审批按 id 去重，重复的 `approval/asked` 或重渲染不重复转达。
- 转述正文裁剪（单条 ≤2000 字符，超出截断并注明「完整内容见会话」）；不转述工具参数、token、路径等敏感细节。

## 4. 统一路由（无 smart-route）

路由目标池 = **协管会话 + 直管 Worker**，由 Ria 判断该给谁；不设 `smartRoute` 开关，不做模型式自主路由。

- 用户对 Chat 说「让 X 去做 …」时，Ria 建 ticket 并派发：目标会话先用 `chatbot_co_manage` 登记为 co-managed 执行者，投递内容是 Advisor WorkOrder（首行 `[WorkOrder #<ticketId>]`）；直管 Worker 走同一套 ticket 派发。协管通道只用于转述/盯进展，不再承担派活。
- **每次路由都通知用户「已转给 X」**；Chat 必须转述，不静默。
- 路由不改变目标会话的权限、模型、工具或 ticket 归属。

**与 ticket 的边界**：同一件事不要既建 ticket 又走协管；需要验收、要跨轮次追踪的正式工作建 ticket，只是「带个话/盯进展」走协管。

## 5. 与 direct 无耦合

协管和 direct 各自独立，**不共享状态、去重表、队列或仲裁**：

- 协管只写 `co-management.json` 与自己的内存 LRU；direct 状态仍在 controller 内存里，互不读写。
- 同一会话同时 direct + watch 时，可能各转一份（`【直通·标题】` 与 `【协管·标题】`），这是**已知行为**；不实现「先到先转/抑制」，也不要求两者同开时的特殊处理。
- 互不影响生命周期：开启/退出 direct 不改 watch；取消 watch 不改 direct。
- 命令解析：`/直通` 系列仍走 direct 钩子；`/协管` 系列由 Chat 解析，direct 生效时需退出直通或在 Web 端操作。

**抽象等同直管 Worker**：协管会话与直管 Worker 只差通信机制（co-managed 会话通过 ticket 接收 WorkOrder）。权限/审批走同一套风险分级与 `audit.jsonl`；状态、事件、限流、失败重试复用同一套 controller 逻辑；`co-management.json` 只存 transport（sessionId、cursors、订阅选项），不另造状态机。

**观测用户直连**：watched 会话的 `user/message` 也订阅；过滤 `host_` 注入后记录摘要与 `lastUserSeq`，以 `【协管·标题】用户直接对会话说：…` 通知 Chat，避免重复派活。

## 6. 命令与工具

用户侧（由 Chat 解析后调用工具）：

| 命令 | 作用 |
|---|---|
| `/协管 <标题或 sessionId>` | 加入协管（等价 `chatbot_watch action=add`） |
| `/取消协管 [id\|all]` | 移除一个或全部 |
| `/协管列表` | 列出 active/paused/stale 的 watch |
| `/协管状态 [id]` | 单个 watch 的选项、游标、统计与最近错误 |

模型侧 `chatbot_watch`：

- `action: add`：`title` 或 `sessionId`（必填其一）、`options`（relayReplies / relayQuestions / rateLimit）；返回 watch 与解析到的会话。
- `action: remove`：`id` 或 `all`；返回移除数量。
- `action: list`：返回 watch 列表与状态。
- `action: status`：`id` 或 `sessionId`，返回游标、统计、stale 原因与 pending 提问。

只有 Chat 能调用；不提供任何改目标配置/权限的入口。派活由 ticket 承担（直管 Worker 或 co-managed 会话），`chatbot_read` 保留为一次性只读查看；watch 是长期状态。

## 7. 去重与限流

- **事件去重**：`sessionId:seq` 有界 LRU（2000 条 / 24h）；提问 `questionId/callId` 有界表。
- **合并窗口**：同一会话的 `assistant/message` 先进缓冲；首个事件起一个 5s 的 **unref 一次性** setTimeout，到点合并成一条。不是轮询/常驻定时器。
- **速率上限**：每会话 6 条/分钟滑动窗口；超出记 `stats.suppressed`，保留缓冲，等窗口到期后的下一次 flush 附带「另有 N 条输出已省略」。
- **id 去重**：同一 ask_user_question 只转达一次；重试沿用同一 batch 去重键。

## 8. 失败与恢复

- **转述失败**：独立内存有界重试（1s/3s/9s 三次退避、总窗口 ≤2 分钟、按 `watchId:batchId` 去重）；超限发 Markdown 可见提示「⚠️ 协管转述发送失败（已重试 N 次）」。**不写 outbox**，不共享 direct 队列。
- **重启恢复**：加载 `co-management.json`，watch 继续；从 `lastRelayedSeq` 往后，**不回放**历史消息；启动时只做一次 reconcile（会话不存在/归档 → stale + 通知一条）。
- **审批被拒/取消**：只记录与通知，不替用户做决定，也不自动重试审批。
- **状态文件损坏**：不阻塞启动；日志告警并以空状态继续（需要用户重新 `/协管`），可选保留损坏文件供排查。

## 9. 分阶段实现

| 阶段 | 范围 | 验收 | 回滚 |
|---|---|---|---|
| **P1（已实现）** | 状态文件 + `chatbot_watch` + `/协管` 命令 + assistant 转述（去重/合并/限流） | 加入后回复带【协管·标题】到达；重复事件只转一次；限流生效 | `/取消协管 all` 或删除状态文件 |
| **P2（已实现）** | question 转达 + approval/request 走风险分级 + user/message 观测 + 统一路由 | 提问到达用户、不代答；low 自动放行、其余转用户并审计；用户直连可观测 | 关闭对应 option；移除 watch |
| **P3（不做）** | smart-route、与 direct 的仲裁/共享去重 | — | 已明确放弃；direct 与协管无耦合 |

每阶段都保持「watch 可随时移除、状态文件可删除」的回滚粒度；不引入常驻定时器。

## 10. 风险与不做

**风险**

- 刷屏：靠合并窗口 + 速率上限 + 摘要折叠。
- 隐私：不转述工具参数、token、路径；转述前裁剪。
- 误路由：无 smart-route，路由只由用户显式指令触发；每次通知「已转给 X」。
- 与 direct 重复：无共享去重/仲裁；同会话同开可能双份转述，属已知行为。
- 状态竞争：独立文件；若未来并入 v2.json，必须先满足单写者或 SQLite 事务（见 sqlite-migration-design）。
- 会话改名：`titleSnapshot` 过期时以列表/状态查询刷新。

**明确不做**

- 不改目标会话配置、模型、工具或上下文。
- 不接管、不催办、不打断目标会话。
- 不自动回答提问、不自动决定审批（用户显式配置的策略除外）。
- 不做无限 watch（上限 20），不做跨机器同步。
- 不轮询、不看门狗；所有判定都挂在事件或命令上。
- 不把工具参数/敏感内容转述出去。
- 不做「既建 ticket 又协管同一件事」的双轨。

## 开放问题

- 协管是否绑定通道（Web / 微信 / QQ 各自一份转述）？
- watch 的事件起点：从加入时刻开始，还是按 `lastRelayedSeq` 回溯最近 N 条？
- 提问的回答回传用普通消息还是 `steer`？目标在跑长任务时的优先级？
- 无 smart-route；未来不做模型式自主路由。
- 与项目级 Advisor、经验库的关系：协管产生的观察是否作为反思素材回流经验库？
- SQLite 落地后 `co-management.json` 是否并入数据库并保留 JSON 导出？
