# ticket 排队 / 依赖机制（历史设计稿）

> 状态：历史设计（2026-11-12）/ 部分实现 / P1 方案未实现
> 现行文档见 [design-history.md](design-history.md) §4.2「排队与依赖」、§4.3「就绪通知：状态即真相」，以及 [tools.md](../tools.md) 的 `ria_ticket` / `ria_request` 条目。

## 背景与目标

- 触发问题：用户说「先做完 A，再做 B」实际含四类需求——顺序链、跨 executor 链、fan-out 后汇聚、条件分支；旧实现全靠 Ria 记忆与自律。
- 核心判断：不是「有排队但不够强」，而是「关系字段存在，语义和驱动都不存在」。
- 证据（2026-11-12 代码）：`dependsOn` 已在 schema、归一化与 addTicket 中保留（`lib/tickets.mjs:131`、`lib/index.js:750`），但 `ria_ticket` 参数表没有它（`lib/index.js:1612-1647`），无校验、无调度。
- `open` 强制 `waitingOn='ria'`（`lib/tickets.mjs:314-317`），枚举无 dependency（`lib/tickets.mjs:27`）；worker idle 只通知「有 working ticket 的 executor」（`lib/worker-idle.mjs:130-135`），A 完成后 B 不会自己触发。
- 启动恢复把 `open` 当待处理单元（`lib/index.js:3225-3243`），重启后 B 会被提示而提前派发；`ria_request` 成功一次即 `concludeTurn()`（`lib/index.js:2668-2675`），同 turn 连派 A、B 不可靠。
- merge 后 source 以 `done + resolution.kind='merged'` 收敛（`lib/index.js:702-712`），不能当「工作完成」解锁下游；`ria_resolve kind=split` 返回 not_supported（`lib/index.js:592-594`）。
- `outbox` 已有持久化、去重、6 次重试、30 秒 tick（`lib/outbox.mjs:11-17`、`:124-149`），唤醒可直接复用，不必新造持久队列。
- 纯 prompt 方案只作回退：顺序只存在上下文里，turn 结束/压缩/重启即丢；没有可查询的「B 在等 A」、没有强制门禁、没有幂等键。
- 目标与边界：增量设计，新增 T29 起，T1–T28 与 10 条不变量不动；不改 `lib/`、`test/`，不重启服务。

## 关键决策（含理由）

- **选 ticket 级 DAG + `waitingOn='dependency'`（方案 A）**，复用 `dependsOn`，不建 plan/queue 实体。理由：与「一个工单一个 executor、预检、note、审批、归档、恢复」同构，不需要第二套生命周期；支持跨 executor 链且不要求先实现 split/fork；只新增一个等待值，不扩散状态；失败/取消可逐单解释，不会出现「plan 说跳过、ticket 还在 working」的双重真相。
- **否决独立 plan/queue 实体（B）**：plan 与 ticket 两套生命周期，merge、归档、reopen、恢复都要双写；runner 若直接派发就绕过 `ria_request` 的预检、note、审批与 recentWorkers，形成第二个调度器；若只解锁则本质仍是 A 的依赖图，只多一层易失配索引。
- **否决 forked 父容器（C）**：split 未开放，P0 先补 fork 成本更高；父聚合语义是「所有子收敛后父收敛」，不是按序启动；父最多 2–8 个子、深度最多 2，跨 root 临时链不适用；那是「一个目标拆几件事」的心智，不是队列心智。
- **不新增 `queued` 状态**：8 态扩 9 会扩散到恢复、归档、客户端过滤与所有转移表；status 表示生命周期位置，waitingOn 表示「在等谁」；用户看到的「排队中」就是 `open + waitingOn='dependency'`。
- **Host 只算 ready，派发仍只由 Ria 触发**：Host 直接发消息会绕过 `session_missing`、`not_top_level`、`session_archived`、`workspace_missing`、`ticket_executor_mismatch` 预检，绕过 note 卡片/微信镜像、recentWorkers、审批观察与现有幂等 delivery；还会让 host 同时拥有调度和执行两种职责。Host 只做三件事：算 ready、写持久信号、重启对账。
- **唤醒以 outbox 持久信号为主**：idle 只负责「A 的 worker 结束了，Ria 去读结果」，B 不是 working 不会触发；启动扫描必须做但 Ria 在跑时不会触发；定时轮询会引入额外 turn，与「ria_status 不等待」冲突。组合为 `queue_wake` 主路径 + startup reconcile 兜底 + turn/end 补泵一次。
- **失败默认 hold + 叫醒 Ria**：不自动 skip/cancel/failed。「A 失败」不等于「B 执行失败」，自动判死会污染验收记录；用户可能想修 A 后继续 B。P1 才加 `onDependencyFailure: 'hold'|'skip'|'continue'|'block'`，默认仍 hold 避免行为突变。
- **级联取消只打排队中的下游**：working 下游不改状态，作为 deferred 返回。Ticket 是状态记录不是杀进程工具；Ria 没有停止 worker turn 的 API，谎报取消比不取消更糟；P1 若做协作取消，加 `cancelRequestedAt` 由 worker idle 时确认。
- **策略放在下游工单而非边**：一张 B 可能被多条边指向，工单级 `onDependencyFailure` 更容易解释；P1 若需更细再做 per-edge。
- **跨 root 默认允许**：一条用户消息只产生一个 root intake，`ria_resolve` 也只能定一张 work 工单；强制同树就得先做 fork/split，P0 成本明显变大。`rootTicketId` 只表 fork 血统，不作依赖边界。
- **schemaVersion 2→3**：v2 已持久化 dependsOn 但从未被工具写入、也从未被语义使用；v3 明确语义与校验。新字段全部可选、可重算，兼容读 v2，首次保存写 v3，`tickets.log.jsonl` 的 schema:1 不变。

## 关键机制与数字

- 字段：`dependsOn: string[]`（去重、最多 8、不能自指/成环/指向 intake）；`readyAt`（最近一次「全部依赖 done」的时间）；`readyNotifiedAt`（最近一次成功把 ready 通知交给 Ria，仅观测）；`dependencyAlerts[{ticketId,status,code:'dependency_failed',at}]`（依赖失败提示，不等于本单 failed）；`queueToken = ticketId:readyAt:revision`（计算值不入库）。
- 等待值：`open+ria` 是唯一可由 `ria_request` 开始的状态；`open+dependency` 必须 `dependsOn.length>0` 且至少一个依赖非 done，否则归一化为 ready；`waitingOn='dependency'` 只允许出现在 open。
- 新增转移 T29–T37：T29 依赖全 done → open/ria，写 readyAt、清 alerts、生成 token、入队 wake，但不派发；T30/T34 上游 reopen → 退回 dependency、清 readyAt、作废未投递 wake（B 已 working 则不回溯，只记历史）；T31 Ria 增改依赖未满足 → 退回；T32 移除依赖或补齐 → ready；T33 依赖 failed/cancelled → 状态不变 + 写 alerts + 入队 `queue_blocked`；T35 级联取消；T36/T37 是 P1 的 skip/block。
- 不变量 11–22 的关键项：依赖图无环（从被依赖工单 DFS，回到自身即 `dependency_cycle`，整次写入不生效）；依赖必须存在，热存储查不到再查 `tickets.log.jsonl`/月日志，否则 `dependency_missing`；`open+ria` 必须所有依赖 done（硬门禁）；merge 先转移依赖边再把 source 收敛为 done(merged)，merged done 不算依赖满足；级联只沿 dependsOn 与 childTicketIds 向下，不允许向上；queueToken 校验失败返回 `ticket_not_ready`。
- 幂等键：wake 用 `queue_wake:ticketId:readyAt`（同一 readiness 只一条，outbox 重试不重复）；启动补发加 `:boot:bootId`（每 boot 最多一条，覆盖「已投递但派发前崩溃」）；派发用 `queueToken=ticketId:readyAt:revision`（已 working、退回等待或 revision 变化都拒绝）；实际投递沿用 requestId + deliveries。
- 崩溃窗口：A done 已存但 B 未转 ready → 启动重算补；B ready 已存但 wake 未入队/未投递 → outbox pending 或启动补发；wake 已投递但 Ria 派发前崩溃 → boot wake 再提醒，token 未用；B 已 working 后崩溃 → 按 working 恢复不重派；级联取消半途 → 已取消的不重开，剩余下游可再次取消。
- 唤醒文案：`[Queue ready]` 可合并多张 ready 工单，每行带 `ticketId | goal | executor | queueToken | 依赖`，并写明「每张工单只能派发一次」；`[Queue blocked]` 明确「不要派发 B」，让 Ria 向用户提供四个选项：重试 A、跳过 B、取消整条链、修改需求。
- 可见性：每张工单增加 `queueState`（`waiting_dependency`/`ready`/`dependency_alert`/`dispatched`/`blocked`）、`queueText`、`blockedBy[{ticketId,goal,status,executor,archived}]`；`ria_status scope=tickets` 增加 `queue{waiting,ready,alerts,items}`，只含非终态且 dependsOn 非空的工单，排序 ready → alert → waiting，同组按 readyAt/updatedAt 倒序。
- 重启：`reconcileDependencies()` 在归档裁剪、审批/workspace 对账之后跑，读热存储 + 归档解析依赖；`open/dependency` 不是恢复单元，只并入排队摘要；`recovery.count` 不统计 queue wake，ready 长期不派发也不会 3 次后自动 blocked——那是「Ria 没执行」，不是「恢复失败」。
- 归档：依赖可指向已归档的 done 工单；reopen 归档的 A 要先从日志捞回热存储再重算，B 若 ready 未派发则退回 dependency；`blockedBy` 标 `archived:true`。
- 上限与写入规则：单工单最多 8 个依赖，超限让 Ria 拆段或问用户，不自动截断；依赖只允许在 open 状态改，working 之后加未满足依赖会制造「已经跑了还在等」的假状态。
- 验收：P0 六条场景——跨两 worker 的 A→B 只派一次、A failed 不派、重启不进恢复列表、重复唤醒不二次派发、A reopen 后 B 退回、cascade 只取消下游；另有 Q-01–Q-17 用例覆盖校验、幂等、归档、merge 与预检失败。

## 实现状态

- P0 已按此稿实现（Phase 27，schemaVersion 3）；仓库当前 schemaVersion 已是 5（v4 加 checklist、v5 加 topics），依赖字段与语义未变。
- 已落地：v3 迁移与 v2 兼容；依赖校验（自指/重复/缺失/环/上限）且整次写入不生效；`open/dependency` 与 T29–T34；ready 计算 + `queueToken` 校验（`ticket_not_ready`）；`queue_wake`/`queue_blocked`；startup `reconcileDependencies` 与恢复单位排除；`ria_status` 的 queueState/blockedBy/queue；`ria_ticket cascade=downstream`（working 下游返回 deferred）；merge 依赖边转移；`ria_resolve kind=work` 支持 dependsOn。
- 测试落点与设计稿不同名：实际为 `test/ticket-queue.mjs`、`test/ticket-queue-restart.mjs`，另有 `test/queue-wake-delivery.mjs`、`test/queue-wake-recovery.mjs`；设计稿提议的 `test/queue.mjs` 未按名落地。
- 实现比设计更强的一处：就绪通知改为「状态即真相」——唯一依据是已提交字段 `status==='open' && waitingOn==='ria' && readyAt` 且 `readyNotifiedAt` 为空；`publishReadyNotices()` 按 `queue_wake:<ticketId>:<readyAt>` 去重，发布点只有「工单写入提交后（同一调用栈）」「startup」「Ria turn 结束」三处，不挂 30 秒常驻对账。
- 事故证据：`ticket_mwf7lpk4_62a20be388` 于 2026-11-14 00:55:32 因上游 `ticket_mwf71wso_fd944757e9` 关闭而就绪，`readyAt` 已写入，但 outbox 没有 `queue_wake`、Ria 也没收到 `[Queue ready]`，空转 3 小时 36 分，直到 04:31 重启才发现；旧实现把通知押在一次性回调上。
- 后加约束：忙碌 worker 禁止排队——`ria_request` 默认 `mode=queue` 时，目标有运行中 turn 或非空 pending 队列直接返回 `worker_busy`；`mode=steer` 只用于信息同步，不得下发新任务。
- P0 当时明确不做：fan-out 汇聚的批量派发体验、`onDependencyFailure`、客户端队列 chip、forked 串行容器、自动重试失败的依赖。

## 仍未实现 / 风险

- P1 四项全部未实现：`onDependencyFailure` 四值策略、多依赖 join 的策略处理（数据模型已能表达「C 依赖 A、B，全 done 才 ready」，但失败分支无策略）、批量派发、GUI 队列视图。
- fan-out 的根因仍在：`ria_request` 一次成功即 `concludeTurn()`，同一 turn 难以可靠派 A 和 B，第二张通常要等下一次唤醒。建议新增 `ria_request_batch`（一次收多个 `{ticketId,targetSessionId,message,note}`，全部预检通过后统一投递、只结束一次 turn），而不是给 `ria_request` 塞 tickets[]。
- 批量派发未落地前，多依赖 join 只能「逐个唤醒、逐个派发」，链越长等待轮次越多。
- 取消仍是单边的：没有 worker 停止/协作取消 API，running 下游只能 deferred；用户看到的「已取消」只覆盖排队部分。
- merge 是依赖机制最易错处：先校验后提交，任何一步失败不写入；source 的 merged done 绝不能当依赖满足，下游必须改等 target。
- queueToken 只保证「一次就绪最多派发一次」，不保证派发后 worker 真的推进；`readyNotifiedAt` 只用于观测，不是派发许可。
- 归档 + reopen + 依赖重算的顺序易错：reopen 必须先捞回热存储再触发重算，否则依赖可能被判 `dependency_missing`。
- 跨 root 依赖默认放开，`rootTicketId` 不再是依赖边界；做 forked 树视图时不要把它误当同树约束。
- 稿中的 schemaVersion 3 已被 v4/v5 接续；引用旧版本号时需注明是「2026-11-12 的方案口径」。

## 现行文档

- [design-history.md](design-history.md) §4.2「排队与依赖」、§4.3「就绪通知：状态即真相」、§4.1「归档与恢复」，以及第 15 节 Phase 27。
- `docs/tools.md` 的 `ria_ticket` / `ria_request` / `ria_status` 条目与工单依赖说明。
- `docs/architecture.md` 的 dependsOn / queue_wake 段；[task-model.md](task-model.md) 的 T1–T28 与 10 条不变量继续有效。
