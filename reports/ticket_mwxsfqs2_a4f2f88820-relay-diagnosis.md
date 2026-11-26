# 协管 relay 未到 Claw：诊断与修复报告

- 工单：`ticket_mwxsfqs2_a4f2f88820`
- 代码：/home/gkl/Desktop/vibe_proj/dsh-ria（本轮只落代码 + 测试 + commit）
- 约束：**未重启、未部署、未 install、未改动 coManagement 登记**
- 现场：`~/.dsh/sessions/--home-gkl-Desktop-vibe_proj-crowd_recon--/session-7421ce08-.../session.v4.jsonl.zstd`（18193 事件）
  、`~/.dsh/state/ria/wechat-claw/assistant.log.jsonl`、`~/.dsh/state/ria/outbox.json`、`~/.dsh/state/ria/state.json`、`~/.dsh/state/ria/ria.sqlite`
- 取证窗口：2026-11-26 22:00 – 11-27 00:45（Asia/Shanghai）

## 0. 一句话结论

relay **每次都触发了**（15/15），既没被 916c7b3 的早退拦，也没被 🔔 标记吞；问题出在 relay 这条链路本身的**两个缺陷**：

1. **正文被折叠**：直转/派单触发的协管 turn 结果也套用了「长报告折叠」，1363 字的答案被折成 172 字提要投递（`controller.mjs:3703` 旧代码 → `notifications.mjs:111-120`）。
2. **失败即丢**：`fallback:false` 关闭了 durable outbox，而 `forwardAssistant` 是 fire-and-forget，`sendWatchRelay` 永远看不到失败，`CoManagement.deliver` 把「没发出去」当成「已送达」——窗口内 3 条 relay 因此永久丢失，无重试、无 outbox、无告警。

即：**「Ria 读得到、手机收不到」= Chat 侧拿到（折叠后的）文本 + Claw 侧要么只收到提要、要么被静默丢弃。**

## 1. 取证①：relay 有没有触发

数据源：`assistant.log.jsonl`（每次 `forwardAssistant` 的落盘记录）× Chat 会话 `session-00eeeafc…` 的 `[Router notice]`（`sendWatchRelay` 的 Chat 镜像）。两者 **1:1 全等**，说明每条 relay 都走到了 channel 调用。

| # | 时间 | relay eventSeq | assistant.log reason | 对应 turn 末条 assistant |
|---|---|---|---|---|
| 1 | 22:02:19 | 17331 | delivered | 153 |
| 2 | 22:09:14 | 17362 | delivered | 154 |
| 3 | 22:14:16 | 17487 | delivered | 155 |
| 4 | 22:16:16 | 17521 | delivered | 156 |
| 5 | 22:20:20 | 17560 | delivered | 157 |
| 6 | 22:22:25 | 17604 | delivered | 158 |
| 7 | 22:25:21 | 17669 | **send_failed (ret=-2)** | 159 |
| 8 | 22:32:55 | 17908 | **send_failed (ret=-2)** | 160 |
| 9 | 00:06:26 | 17982 | **send_failed (ret=-2)** | 161 |
| 10 | 00:09:43 | 17990 | delivered | 162 |
| 11 | 00:18:27 | 18020 | delivered | 163 |
| 12 | 00:27:19 | 18080 | delivered | 164 |
| 13 | 00:30:02 | 18109 | delivered | 165 |
| 14 | 00:34:04 | 18155 | delivered | 166 |
| 15 | 00:39:40 | 18189 | delivered（chars=172，原文 1363） | 167 |

三种情况的区分（工单要求）：

- **没调用**：排除。15/15 都有 channel 调用记录。
- **调用了被早退**：排除。早退发生在 `sendWatchRelay` 开头（`controller.mjs:3695-3704`），早退则既无 `assistant.log` 也无 Chat notice；两者同时存在。
- **调用了但 outbox 未入队**：**命中 3 次**（#7/#8/#9），这正是缺陷 2。

## 2. 取证②：outbox 状态

`outbox.json` 快照（读取时刻 00:51）：

- 条目 69 条，`kind` 全为 `wechat_assistant_note`；`status` 全为 `delivered`。
- **pending = 0，failed = 0**（该实现只有 pending/failed/delivered 三态，**不存在 `deferred`** 状态；`deferred` 是 Claw 发送层的即时返回语义）。
- 最老 pending age：不适用（无 pending）。
- `payload.reason` 分布：`send_failed` 62 条、`summary` 7 条；最后一条 createdAt 00:06:39 → deliveredAt 00:09:32。

**ret=-2 旁支（按 cog_257 处理）**：窗口内 `assistant.log` 有 18 条 `send_failed`，全部 `errorCode=WECHAT_CLAW_PEER_REJECTED`、`ret=-2`、`errmsg=prepare failed`。这是服务端凭据轮换，只能靠 inbound 刷新 token（`outbox.retryWhere` 在 `index.js:6800` 的 inbound 路径重新武装）。现有代码对该错误只写 `channel.degraded` 事件（`index.js:6682`），**不推用户**——本单未新增任何用户推送，保持该策略（详见 `reports/claw-ret2-fix.md`）。

关键对照（说明「不持久」才是缺陷）：

- 同一 ret=-2 时刻，Ria 自己的回复 `fallbackQueued:true` → 进 outbox → 在 00:05:33 / 00:09:32 补投成功；
- 协管 relay 三条 `fallbackQueued` **缺省**（`wechat-claw.mjs:1360` 的 `options.fallback !== false` 被 `fallback:false` 关掉）→ outbox 无对应 `eventSeq` → 永久丢失。

## 3. 取证③：emoji 标记（任务结果 → 🔔）是否吞 relay

打标/消费链路：

1. 注入时打标：`controller.mjs:3561`（`chatForward` 直转）、`controller.mjs:7216`（dispatch/resume）。
2. `assistant/message` 时把标记**拷到 buffer 上**：`controller.mjs:3947-3951`。
3. `turn/end` 清标记：`controller.mjs:1133-1139`，**早于** `handleWatchEvent`（`:1166`）执行。
4. 真正消费在 5s 合并窗口后的 `flush` → `sendWatchRelay` → `taskTriggered = event.riaTaskTurn`（`controller.mjs:3717`）。

生产顺序是「assistant/message → turn/end →（5s 后）flush」，即**标记一定先被清、relay 一定后发**。用 fixture 按此顺序实测（本轮 probe）：

```
marks: forward ok true marker true
marker after turn/end false
sent [{"kind":"notice","fallback":false,"task":true}]
```

结论：标记被拷贝到 buffered event 上，turn/end 清的是 session 级 map，**不影响**已入缓冲的 relay；emoji 改动**不会吞 relay**。唯一残留缺陷是「turn 进行中注入直转 → 当前 turn 的 turn/end 会提前清掉标记」，那只影响 🔔/🌊 归类，不会丢 relay，本单不扩大改动。

## 4. 取证④：916c7b3 的早退分支

- 早退点：`controller.mjs:3695-3704`（旧的 3689），条件 `executorWorkingTicket(watch.sessionId)`。
- 判定数据源：`executorWorkingTicket`（`controller.mjs:1394`）
  1. `workingTicketFor`：`tickets.status === 'working' && ticket.executor === sessionId`（`approval-coordinator.mjs:238-241`）；
  2. 回退：`executor.currentTicketId` → 该票 status === 'working'。
- 现场：`ria.sqlite` 中 `session-7421ce08` 名下仅 **cancelled 1 + done 2**，无 working；`state.json` 的 `executors` 里该 session **连镜像都没有**（38 条全 managed、co-managed 0 条），因此 `currentTicketId` 回退也不可能命中。
- 行为证据：15 次 relay 全部有 `assistant.log` + Chat notice（早退会两者皆无）→ **本窗口内早退分支一次都没命中**。

结论：**不是本单根因**。但仍修了它的两个隐患：

- 回退分支原来不校验 `ticket.executor === sessionId`，一个残留的 `currentTicketId` 指向别人名下的 working 票就会把无票协管永久挡在 ticket lane 上（真误拦）；
- 早退原本**完全静默**，事后无法与「已送达」区分 → 现在写 `relay.skipped` 事件（`controller.mjs:3703`、`:3796`；assistant 入口 `:3944` 同一事件）。

## 5. 取证⑤：relayReplies 配置

- `state.json` → `coManagement[watch_mwuo5v7n_ad81d2d2]`：`status:"active"`、`options.relayReplies:true`、`allowDispatch:false`。
- 生效点：`co-management.mjs:357`「`!watch || watch.options.relayReplies === false` 才跳过」。
- 默认值：`co-management.mjs:31` `relayReplies: value.relayReplies !== false`（缺省 true）；`add()`/`update()` 都过 `normalizeOptions`。
- 旧快照覆盖：无。`active()`（`:184-187`）只按 `status === 'active'` 过滤；遗留 `inactiveAt`（11-25 14:11，`remove` 后 `add` 复活时的残留）全仓**无读取点**（grep 仅 `:79` 归一化 / `:268` 写入）。
- 结论：**配置正常，不是根因**。

## 6. 根因判定与排除依据

**根因（同一条链路的两处机制缺陷）**

1. **任务结果被折叠成提要**（正文到不了手机）
   `controller.mjs:3695` 的 `sendWatchRelay` 对 `riaTaskTurn` 也调用 `formatRelayBody(body, maxChars=400, {ticketId:null})`；`notifications.mjs:111-120` 对 report-like 文本只取首段 + 「（报告较长，已折叠；完整内容已记入会话记录）」。
   证据：turn 167 末条 assistant 原文 1363 字（含 BA 全表 + 3 条结论），实际投递 `chars=172`，正文只有「先回答第一问…」；Ria 随后手动 `ria_chat_read` 才看到全表。
   （「完整内容已记入会话记录」对手机用户没有意义：那条记录在协管会话里，用户看的是微信。）

2. **失败/跳过不可观测且不持久**（发送失败 = 永久丢失）
   `controller.mjs:3739` 旧为 `fallback:false` → `wechat-claw.mjs:1360` 的 durable 兜底被关掉；`forwardAssistant`（`wechat-claw.mjs:1373-1412`）是 fire-and-forget，调用方拿到的永远是 `undefined`，所以 `sendWatchRelay` 里 `result === false` / `reason === 'send_failed'` 两个判定**永远不成立**；`CoManagement.deliver`（`co-management.mjs:444-461`）因此把「没发出去」记为成功（`flush` 里 `stats.relayed += 1` / `lastRelayAt`，`:431-441`），既不重试也不通知。
   证据：#7/#8/#9 三条 relay `send_failed` 且无 `fallbackQueued`、outbox 无对应记录；而同时刻 Ria 自己的回复有 `fallbackQueued` 并最终补投。

**排除依据**

| 候选 | 结论 | 依据 |
|---|---|---|
| relay 没触发 | 排除 | 15/15 有 `assistant.log` + Chat notice |
| 916c7b3 早退误拦 | 排除 | 名下无 working 票；早退则两者皆无 |
| emoji 标记未消费 | 排除 | 标记已拷贝到 buffer；生产顺序实测 kind=notice |
| `relayReplies` 失效 | 排除 | state/默认值/读取点三处一致为 true |
| `ret=-2` | 旁支（cog_257） | 凭据轮换，靠 inbound 刷新；只写事件、不推用户 |
| outbox 卡 pending/deferred | 排除 | 0 pending、0 failed；协管 relay 根本没进 outbox |

## 7. 修复内容（最小、按机制）

| 文件 | 改动 |
|---|---|
| `lib/core/controller.mjs` | ① `sendWatchRelay`：直转/派单 turn（`riaTaskTurn`）**投全文**（不再折叠），自然闲聊仍走 400 字折叠；Chat 侧副本保持折叠，避免把多 KB 正文灌进 Ria 自己的上下文（`:3714-3730`）。② `fallback:true` + `sessionId`/`turn` 透传（`:3732-3748`）→ 失败/暂停落 durable outbox。③ `onSettled` → `relay.delivered`/`relay.failed` 事件（`:3796-3825`），失败可取证。④ `handleWatchEvent` 在 `turn/end` **边界 flush**（`:3968-3976`），不再依赖 5s 合并 timer 决定 turn 结果是否出门；`flush()` 会 splice buffer，定时器不可能二次发送。⑤ `recordWatchRelaySkipped` + `relay.skipped`（`:3703`、`:3944`）让早退可观测。⑥ `executorWorkingTicket` 回退分支加 **归属校验**（`:1394-1405`）。 |
| `lib/channels/wechat-claw.mjs` | `forwardAssistant` 把 `sessionId`/`turn` 带进落盘记录与 `onAssistantUndelivered`（`:1373-1412`），使 durable 兜底按来源会话打键。 |
| `lib/index.js` | `notifyWechatAssistantFallback` 去重键改用**来源会话**（`:6716-6742`）+ payload 记录 `sourceSessionId`/`turn`：不同协管会话同 seq 不互相吞、同一 turn 只有一条。 |
| `test/co-managed-relay-outbox.mjs` | 新增：直转 turn 结束必 relay（全文、notice、只一条）、无 working 票不被早退、有 working 票按设计早退且写事件、被拒 relay 落 outbox 且同一 turn 只一条、空 turn 不伪造 relay。 |
| `test/claw-kind.mjs` | 早退用例补 `relay.skipped` 断言。 |

**未改动**：`coManagement` 登记（未 add/update/remove/retire 任何线上条目）、settings、outbox 文件、任何状态库。

## 8. 测试

- 单测（新增 + 相关回归）：`claw-kind`、`claw-task-relay`、`co-managed-relay-outbox`、`co-managed`、`co-managed-stats`、`co-managed-titles`、`co-management`、`co-management-archive`、`co-management-binding`、`co-management-state`、`co-management-unified`、`co-manage-autoregister`、`co-auto-track`、`relay-truncation`、`status-notice`、`turn-end-fallback`、`chat-forward`、`outbox-pump`、`session-abnormal-notice`、`notice-scope`、`blocked-notices` 全 PASS。
- 全量：`node scripts/run-tests.mjs`（178 个用例）见本次提交说明/工单报告里的输出。

关键断言（`test/co-managed-relay-outbox.mjs`）：

```
calls[0].options.kind === 'notice'          // 直转 = 任务结果（🔔）
calls[0].options.fallback === true          // 失败必须 durable
calls[0].text 含 "| k1 | BA k1 |"           // 正文，不是提要
calls[0].text 不含 "已折叠"                  // 任务结果不折叠
turnEnd 重复 → calls.length 仍为 1           // 同一 turn 不重复发送
有 working 票 → busyCalls.length === 0 + relay.skipped
被拒 → outbox 恰 1 条 wechat_assistant_note，payload.sourceSessionId = 协管会话，ret=-2 记在 relay.failed
```

## 9. 未部署说明与「重启后」一次性验证

**本轮未重启、未部署、未 install。** 运行中的进程仍加载旧代码（插件以 symlink 指向本仓库，重启即生效）：

`~/.dsh/profiles/web/node_modules/dsh-ria -> /home/gkl/Desktop/vibe_proj/dsh-ria`

用户决定重启后，按下面步骤做一次性验证（约 1 分钟）：

1. 在 Chat 里直转一个问题给「众源重建」，让它给出**带表格/多段**的长答案（例如「把 k1 扫描的 BA 全表和结论再发一遍」）。
2. 等它 turn 结束（Chat 出现 `[Router notice] 【协管·众源重建】…`）。
3. 手机微信应收到 **🔔** 消息，且内容包含完整表格（不再只有「（报告较长，已折叠…）」）。
4. 服务端取证（应恰好各一条）：
   - `~/.dsh/state/ria/wechat-claw/assistant.log.jsonl` 末尾一条 `reason:"delivered"`、`chars` ≈ 原文长度；
   - `~/.dsh/state/ria/logs/<今日>/router-events.jsonl` 出现一条 `"event":"relay.delivered"`（带 `seq`/`turn`/`chars`）；
   - 若这次没发出去（ret=-2 等）：出现 `relay.failed`（含 `ret`）且 `outbox.json` 多一条 `wechat_assistant_note`、`payload.sourceSessionId` = 协管会话 id；再发一条微信消息触发 inbound 后，outbox 会在下一次 tick 补投（`Outbox.retryWhere`）。
5. 重复发送校验：同一条 relay 只对应 **1 条** `assistant.log` 记录与 **1 条** outbox 条目；`turn/end` 重复不会新增。

若重启后仍收不到，优先看 `relay.skipped`：出现即表示该会话当时**确实**绑着 working 工单（按设计走 ticket lane），事件里带 `ticketId` 可直接定位。

## 10. 旁支记录（不在本单修复范围）

- `ret=-2` 属服务端凭据轮换（cog_257）：现有策略是「只写 `channel.degraded` 事件 + inbound 重武装 outbox」，本单未新增用户推送。详见 `reports/claw-ret2-fix.md`。
- 遗留观察（未修，非本单根因）：`state.json` 的 `executors` 里没有任何 `kind:"co-managed"` 镜像（coManagement 有 6 条登记），而 `syncCoManagedExecutors` 本应生成；这会影响协管会话的 `isCoManaged` 分支（如 `handleCoManagedEvent` 收报告），不影响 relay。建议另开一单核对 `SyncCoManagedExecutors` 的持久化时机（`store.mjs:175-215`、`load()` 只在内存同步、不 save）。
