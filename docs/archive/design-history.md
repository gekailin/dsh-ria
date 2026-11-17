# dsh-ria 历史设计归档（v0.31）

> 状态：历史设计（v0.31，2026-11-15）/ 部分实现 / 仍有未实现方案
> 现行文档见 [docs/architecture.md](../architecture.md) 与 docs/ 下各专题。

## 背景与目标

- Ria（阿汐）是全局唯一的普通顶层 DSH Session，固定以 PTC preset 启动（agentPreset=ptc）；模型只直接看到 run_code 与生成的 SDK，15 个 ria_* 工具必须在 SDK 生成前注册，经 tools.ria_* 调用。
- 职责是管理而非代劳：听懂需求、写成 ticket 并定义验收、派给已有或新建的顶层 worker、等 worker 停下再读结果；用户明确要求时才自己执行（executor=self）。
- 明确不是 subagent、不是 Agent Team Lead、不是多 Agent 编排器；不轮询 worker 进度，不起独立 bridge 进程，不占额外端口。
- 边界外：attach/detach 与 managed 会话列表、needs_input/failed 的事件级唤醒、Host 强制 brief 与澄清门禁、多实例锁与 409 防双开、lessons/FTS5/向量检索、专用 worker preset。
- 保留三条主线：全局单例 + 按需 status、微信进程内接入、memory.md。

## 关键决策（含理由）

- 一张 ticket 只对应一个 executor；要广播就建多张票。理由：一票多执行者时状态无法收敛到单一结论。
- 依赖不新增 queued 状态：有未完成依赖即 open + waitingOn=dependency，全部 done 后写 readyAt、转 open + waitingOn=ria。理由是状态机维持 8 态，排队态完全可由字段推导。
- 就绪通知「状态即真相」：唯一依据是已提交的 status/waitingOn/readyAt/readyNotifiedAt，不押在一次性回调上。起因是 ticket_mwf7lpk4_62a20be388 在 2026-11-14 00:55:32 就绪后 outbox 无 queue_wake、Ria 也没收到 [Queue ready]，空转 3 小时 36 分，直到 04:31 重启才被人发现。
- 派发就是一条普通用户消息（source=user-rpc，不加任何前缀）；确认卡片走 conversation.chat.turnTail。早期用 command/run + command/done，卡片被 ChatNodeSeat 当 process member 折叠，真实 UI 不可见。
- 欢迎提示改由 client 渲染（conversation.input.dock，仅 blank 时显示）。早期写合成 turn 1，其 assistant/message 排在真实 system/message 之前，违反 v4 校验 `system/message requires a protected first surface head`，重启 resume 报 corrupt。
- 副作用走至少一次 outbox：宁可重复（微信已发但未落盘会重发）也不静默丢；卡片按 noteId 去重。
- memory 只做 core + archive 两层：core 放稳定偏好，放不下的细节按主题拆到 archive，archive 绝不注入 prompt；不自动总结、不静默覆盖手写内容。
- 微信客户端跑在 DSH 进程内，复用文件传输助手协议，不做 bridge、不占端口、不用 UDS/socket。
- 临时提权只由用户明确指令触发（set 必须 userConfirmed=true），Ria 不得因工单 blocked 或自己的判断自动放宽。

## 关键机制与数字

- 状态机：intake/open/working/blocked/forked/done/failed/cancelled 八态，终态为 done/failed/cancelled；answered/merged/control 是 done.resolution.kind 而非状态。只有 RiaStore.transitionTicket 能改 status，校验转移表与 22 条不变量；非法转移返回 invalid_transition，expectedRevision 不符返回 stale_revision，都不静默改写。
- waitingOn 取值 ria/dependency/worker/user/approval/environment/children/none，由状态决定；dependency 只出现在 open。blocked 必须有非空 blockedReason 且 waitingOn ∈ user/approval/environment；done 必须有 resolution.summary；failed 必须有 failure.code+message。
- intake 四层强制：agent/pre-step 登记、ria_resolve 逐条定性（每条只能一次）、agent/turn-stopping 二次兜底转 blocked、turn/end 按 aborted(user)/error 收尾。
- 归档：热存保留全部非终态 + 最近 24 小时或 closedAt 最新 50 条终态；超出写 tickets.log.jsonl 与按月 tickets-YYYY-MM.jsonl（保留 12 个月）；读侧按 ticketId + closedAt 去重。
- 就绪发布点只有三处：工单写入提交之后（同调用栈，不走 emit 回调）、进程 startup、Ria turn 结束；入队后 +2s/+10s 各做一次一次性核验，不挂常驻对账，也不把扫描塞进 outbox 重试。
- 重启恢复单位只有 intake/open/working；forked 只递归子票，父容器不算；blocked/failed/done/cancelled 不自动恢复；单票连续恢复上限 3 次，超限转 blocked + failure.code=recovery_exhausted 并发卡片；所有候选合并成一条 prompt。
- 依赖最多 8 个，不可自指、重复、指向 intake 或成环；上游 failed/cancelled 不改写需求，只写 dependencyAlerts 并发 [Queue blocked] 让 Ria 报告用户；上游 blocked 只是继续等。
- 队列撤回（ria_queue）：只能删仍 pending 的消息，不 cancel turn、不改票、不影响 recentWorkers；itemId 或 rpcId 定位（rpcId 就是 ria_request 返回的 requestId），失败码 queue_item_not_found / queue_remove_failed。
- queueToken = ticketId:readyAt:revision，不入库；ria_request 必须带当前 token，否则 ticket_not_ready，保证同一次就绪最多派发一次。
- outbox：stateDir/outbox.json，独立于 ria.json；退避 10s/1m/5m/15m/1h，最多 6 次后标 failed 并保留 lastError；delivered 留 24 小时，队列上限 500 条，pending 不清理；触发点为 startup、turn/start、派发路径结束与 30 秒 tick。
- 审批观察：只读监听 approval/request，把活跃工单迁到 blocked + waitingOn=approval 并写 attention，随即 next()；15 分钟 TTL、abort、shutdown 都清理；重启把没有 pending 的审批票恢复 working。
- 临时权限：TTL 默认 30 分钟（60 秒到 24 小时），一个 worker 同时只能有一个有效 grant；审计写 stateDir/audit.jsonl（0600）。
- memory core：stateDir/memory.md，0600，按 Unicode code point 计 maxChars 2400 字符 / maxEntries 12 条 / maxEntryChars 300 字符；90% 预警，硬超限整次拒绝并以 `No changes were made.` 结尾；archive 在 memory-archive/<slug>.md，单文件 16 KB 软上限，read 默认 4000 字符、支持 offset。
- checklist：有序 {text, done}，最多 50 条、每条 ≤200 字；支持 replaceAll 重建、drop 删旧项、check 单项切换，错误码 checklist_invalid / checklist_index，终态拒绝 check。
- request：ria_request 必带 ticketId 与 note（note ≤500 字），ticket 必须存在、未关闭且 executor 匹配目标；错误码 not_top_level/session_missing/session_archived/workspace_missing/ticket_executor_mismatch；多目标可部分成功，全成功才 concludeTurn。
- 微信：积压超过 10 条只补发最后 10 条并提示；文本按 1800 字切块、超过 4 块截断；长或复杂回复转 .md（默认 800 字，代码块/表格/4 个标题/6 个链接任一命中），文件名 ria-<Session 后 8 位>-YYYYMMDD-HHmmss.md，失败回退文本。
- 微信图片双向默认开启：只认 PNG/JPEG/GIF/WebP，上限 20MB（入站再取宿主 imageLimits.maxImageBytes 的较小值）；入站落 stateDir/wechat-inbound，目录 0700、文件 0600，保留 30 天且最多 500 个。
- 暂停推送只停出站：连接、登录态、轮询、入站都不受影响；手动暂停优先于自动暂停，只有微信入站能清除 manual；host_ 合成消息与 source.kind=schedule 不参与通道判定；恢复后按 lastHumanMessageAt 锚点重放。
- 近期 worker：只统计成功派发，窗口 7 天、最多返回 20 个、记录保留 30 天；worker idle 通知只对 working 票的 executor 触发，按 worker+ticket 节流 30 秒，默认开启（notifyOnWorkerIdle、DSH_RIA_WORKER_IDLE）。
- 看板：横轴项目、项目内主题卡 200px、最多 2 列；卡内待执行 2 条、执行中 3 条、已完成只显示计数；主题弹窗 2–3 列网格；滚动区 min(72vh, 680px)；GET /board limit 默认 60（1–200）并支持 before 分页；搜索按状态活跃度排序、首屏 40 条。
- 主题：ria_topic 支持 create/update/link/unlink/merge/archive/list；merge 把源主题链接改指目标并写 mergedInto + archivedAt，archive 要求主题无未完成工单（否则 topic_unfinished）；suggest 只读，按 NFKC 小写后的汉字 2-gram + 拉丁 token 交集 Dice 打分，limit 默认 5（1–20）。
- 说话风格：总开关默认关闭，preset 为 concise/warm/formal/playful，custom ≤300 字；关闭时 manager prompt 与未引入该功能时逐字节一致。
- 写入：ria.json / outbox.json / memory.md 均为进程内 mutex + 临时文件 + fsync + rename，权限 0600。
- schema：当前 v5，新增 topics[] 与 links[]，一张票最多一个 primary link；旧 v4 原样加载，首次写入前备份 ria.json.v4.bak。

## 实现状态

- Phase 0–35 的流水账只记一句：单例入口、PTC 创建、ticket 状态机/依赖/归档/恢复、派发 note 卡片、idle 唤醒、审批观察与临时权限、模型选择、队列撤回、checklist、主题看板、副作用 outbox、会话改名、进程内微信（文本/.md/图片双向/暂停）均已实现到 v0.31。
- 纠正：memory 预算早已不是 4 KB（architecture.md 与旧段落里的 4 KB 已过时），实际为 2400 字符 / 12 条 / 单条 300 字符。
- 工具数以 15 个为准：第 5 节表格只列了 14 个，漏掉 ria_reflect。
- 定期反思：lib/reflection.mjs 已实现单次运行专用的 6 个只读证据工具、run 生命周期（run.json/state.json/.lock）、标题「反思 YYYY-MM-DD」与同日重跑「（第N次）」，runId 形如 refl-YYYYMMDD-<6hex>；报告路径 reflections/YYYY-MM-DD.md，另有 .partial.md、.manual-HHmm.md 与 runs/<runId>/report.partial.md。设置页「定期反思」默认关闭，开启后维护「Ria: 定期反思」计划。
- 通道：v0.31 只覆盖微信「文件传输助手」；现行已拆成三个进程内通道（微信 Claw、QQ 机器人、文件传输助手），见 channels.md。
- 验证环境为 DSH 0.2.2-rc.1 + Node 26 的隔离 profile 副本，npm test 51 个 suite 全过；真实微信账号下的 .md 与图片收发、暂停期连接保持均未验证。

## 仍未实现 / 风险

- P1 分叉未实现：ria_resolve 的 split 返回 not_supported。设计是父票 status=forked、executor=null 只作容器，子票 2–8 个、forkDepth 上限 2，全部子收敛后按 blocked > failed > cancelled > done 聚合。
- outbox 与 ria.json 不是同一事务：派发已被接受、outbox 尚未落盘时崩溃会丢副作用；入队写盘失败只记 warning，既不可重试也不在状态里可见。
- 至少一次会重复：微信在「已发送但未记 delivered」时可能重发；选择接受，以换取不静默丢失。
- 第 12 节仍写 schema v4，与 4.4 和 Phase 31 的 v5 冲突；以 v5 为准，第 12 节的字段清单缺 topics/links。
- 恢复上限只在启动时判定；给 Ria 的通知若发送失败只记日志，票仍保持 blocked，等用户或下次启动处理。
- 临时权限恢复只能写回原 effective mode：DSH 没有清除 sandbox override 的 API，可能留下一个同值 override；该功能也未在真实会话中触发过。
- 审批观察器从不改变审批结果，仍需用户在 worker 会话里批准；没有 UI answerer 时宿主返回 unavailable。
- 防误发提示与近期 worker 选择都只是行为约束，模型可能忽略；Host 不强制。
- 反思读工具默认条数偏大：read_tickets 默认 80，试跑中 97 张票取 80 张即 52,202 字符，建议 window/history 默认 20。
- 安全边界：UI API 校验 DSH 同源；微信在进程内，没有额外的 loopback API；不自动上传、不遥测；memory.md 禁止写凭据或 token。
- 单 Host 假设，两个 DSH 实例可能双开；删除 Ria 不删 ticket、memory.md 与微信凭据。
- 微信把 Ria 的全部 assistant 回复同步出去（已接受）；.md 发送失败回退文本时，超过 4 块仍按原策略截断；工作区列表会多出一个 Ria 专用 Workspace。

## 现行文档

- [docs/architecture.md](../architecture.md)：当前系统顶层地图（边界、对象、流程、可靠性）。
- [docs/tools.md](../tools.md)、[docs/wechat.md](../wechat.md)、[docs/state-and-api.md](../state-and-api.md)、[docs/testing.md](../testing.md)、[docs/limitations.md](../limitations.md)、[docs/channels.md](../channels.md)。
- [task-model.md](task-model.md)、[ticket-queue.md](ticket-queue.md)：ticket 与依赖细节；[daily-reflection.md](daily-reflection.md)：反思。
- 根 [DESIGN.md](../../DESIGN.md)：核心设定，不由 agent 直接修改。
