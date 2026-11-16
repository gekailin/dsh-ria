# Ria 定期反思（Daily Reflection）设计
> 状态：历史设计（2026-11-13 起稿，2026-11-14 补齐编排层，2026-11-16 统一命名与报告路径）/ 部分实现 / 方案未实现：报告渲染与归档 UI、多天回填、wiki 长期层
> 现行文档见 [design-history.md](design-history.md)、[state-and-api.md](../state-and-api.md)、[tools.md](../tools.md)、[testing.md](../testing.md)；实现以 `lib/reflection.mjs` 与 `test/reflection*.mjs` 为准。

## 背景与目标

- 每次反思只回答四个问题：哪些活没闭环；哪些是 Ria 自己的处置问题；有哪些可复用的教训（写成“触发条件 → 做法”，不是流水账）；有没有值得沉淀成 memory 的稳定偏好（只提议）。
- 非目标：不自动修代码/派工/建工单、不自动改 memory、不重启 dsh web、不碰 `dsh-daemon`、不写 worker 会话、不 resume 冷会话、不做实时监控、不把原始会话内容放进仓库。
- 成功标准：单次 8 分钟目标、15 分钟硬顶；worker 输入 60k tokens 目标 / 90k 字符硬顶；每条错漏必须带 `ticketId`/`sessionId`/`turn`/证据；同日重复触发不产生第二份自动报告；除 `reflections/` 外零写入；memory 在用户确认前字节不变。
- 硬约束来自实测：2026-11-13 当天 12 个会话合计 102,363,990 bytes 压缩（Ria 9.77MB、Ria开发 35.87MB、底商 24.41MB、f725 27.41MB），全量解压 300MB+；单份 7.94MB 日志解压后 25.29MB / 10887 行。必须在入口限流、采样、截断。

## 关键决策（含理由）

- **反思由独立的只读 worker 写，Ria 不自己写**：Ria 的上下文已被当天对话污染，容易替自己辩护；新 worker 的上下文、预算、失败边界独立，跑挂不污染主会话；worker 会话留在最近列表可追溯，不归档、不复用，下次另开。
- **Ria 只做管理**：收 reminder、加锁、派 worker、等结束、审阅报告、写 state、收口 intake；不读长 transcript、不写报告正文、不替 worker 分析。
- **一次性运行，同一时刻只允许一个**：`reflections/.lock` 用 `O_CREAT|O_EXCL` 原子建；TTL 20 分钟（大于 15 分钟硬顶），但过期不等于可抢——worker 仍 running 时返回 `locked:true`，只有 worker 不存在、已 idle 且无有效报告，或用户 `force` 时才接管，旧 run 标 `abandoned`，其后续写入按 `runId` 拒绝；不并行跑多个 `forDate`，补跑与当日反思串行。
- **新增 6 个只对本次 worker 注册的只读工具**（`ria_reflect_status/read_tickets/read_sessions/read_session/read_context/report`）：`ria_*` 是按 Ria 会话条件注册的，普通 worker 一个也拿不到；若给普通 preset 让它用 `read`/`bash` 直读 `DSH_HOME/sessions`，就没有 sessionId→路径映射、窗口过滤、脱敏与坏帧处理，既不安全也不稳定。
- **`forDate` 取 `occurrence_at` 的上海日期，不是收到消息的日期**：`windowStart = forDate 00:00:00.000 +08:00`，`windowEnd = min(occurrence_at, forDate 23:59:59.999 +08:00)`；Ria 23:40 在忙、00:05 才跑，仍只反省前一天。按 `state.scheduleId` 在 reminder 载荷里找本任务，找不到就忽略，不用本地时间反推。
- **三重幂等**：`state.lastCompletedDate` + 锁 + `run.json`；重复投递直接回“已反省，跳过”，不 spawn。只有 `complete` 推进 `lastCompletedDate`，推进取 `max(旧值, forDate)`，只存单个日期不存数组，手动补旧日期或 force 重跑都不回退。
- **不建反思工单**：一年 365 张会淹没看板；运行账本是 `run.json` + `state.json`。schedule reminder 若被 intake 捕获，`begin` 时按 `/反思|反省|reflection/i` 或 goal 含 `forDate` 绑定至多一条并立即 `answered`；`finish` 只处理这个绑定的 id，关闭前做相关性校验，不匹配返回 `intake_unrelated` 并记 warning。
- **memory 只提议、不自动改**：memory 每轮注入，写错会持续影响行为；日报写错只影响一次阅读。用两周验证候选质量再考虑自动写。
- **报告不进仓库 `docs/`**：仓库是 public（`git@github.com:gekailin/dsh-ria.git`），日报会引用用户原话、工单目标与 worker 路径；写到 `~/.dsh/state/ria/reflections/`，目录 0700、文件 0600。
- **只用官方 schedule，不自建 timer**：`target=this_session`，插件不实现 timer（DSH 重启后 timer 会丢，且与官方 schedule 双轨）。startup 不直接 spawn，改用 90 秒后的一次性 schedule 补跑；宿主没有 schedule 服务时直接注入 `host_` 提醒。
- **一次 spawn 的成本高于让 Ria 顺手写**：换来干净上下文、可审计的 worker 会话、worker 失败不污染 Ria；并发被锁限制为 1，不叠加多份成本。

## 关键机制与数字

- 状态机：`idle → starting → running → completed|partial|failed|timed_out|cancelled`，外加 startup 的 reconcile；`completed` 是唯一推进态；`partial` 是有效报告但不阻止下次同 `forDate` 自动重跑（覆盖前保留 `.partial.bak`）；`cancelled` 不自动重试。
- 重试：总尝试上限 2 次（首次 + 最多 1 次），只在确认没有 live worker 时自动重试；spawn、dispatch、worker 结束无报告、报告校验失败、deadline 已过且 worker 已 idle 无报告，均可重试一次；超时但 worker 仍 running 标 `timed_out`、不自动重跑、等用户；手动 `force` 不受自动上限约束但仍受单锁约束；每次重试写 `run.json.attempts[]`，不覆盖历史。
- 证据链：`ticketId → executor/sessionId → turn（turn/start 的 data.turn）→ 事件 → 原文摘录 ≤200 字`；归档稳定键是 `ticketId + closedAt`（reopen 后可能多条）；每条结论标 `已对账`/`未验证`，`未验证` 只能进“观察”，不能进“教训”或 memory 候选；`status`/`updatedAt`/`closedAt` 只用于筛选排序，不写成结论。
- 真人 vs 注入：2026-11-13 复盘 442 条 `user/message` 中 274 条是宿主注入、真人只有 168 条；报告统计“真人消息/注入消息/工具调用”三个数，判断“用户纠正”只看真人消息。
- `ria_reflect_read_session` 契约：`mode` 默认 `summary`（user 消息 + 每 turn 最后一条 assistant 文本 + 折叠的 tool/thinking brief），`full` 必须给 `refs` 或 `from/to`，否则 `invalid_window`；`refs` 1–50 且与 `from/to` 互斥；`maxMessages` 1–200（summary 默认 50 / full 默认 20）；`maxChars` 1–40000（summary 默认 10000 / full 默认 40000）；`tailTurns` 1–50 仅 summary；summary 每条 text 截 1000 字、`brief.preview` ≤80 字，full 每条截 2000 字；`corruptFrames>0` 不把坏帧当事实；`finish/abort` 后所有工具返回 `run_closed`。
- 预算：墙钟 8 分钟目标 / 10 分钟软顶 / 15 分钟硬顶；worker 输入 60k tokens 目标 / 120k 字符硬顶；会话 6 个目标 / 8 个硬顶；原始日志深读 2 / 3 个会话，每会话 ≤40KB 文本、只读压缩文件尾部 4MB、3 个窗口或 50 个 ref；报告 20KB / 30KB；输出 5k / 8k tokens；Ria 侧 1 次 begin + spawn + dispatch + finish，硬顶 5 次工具调用。
- 三层读取：Tier 0 结构化数据 ≤20KB（工单/归档/outbox/memory/schedule）；Tier 1 每会话 `summary + tailTurns:10`（超过 6 个会话降 8，Ria 自己 16），典型 50 条原始事件压到 24–28 条摘要、约 2.9–3.4k/会话，8 会话 23–27k，加 Tier 0 共 43–47k（旧方案 74k）；Tier 2 只对 P0/P1、`failed`、`blocked`、`recovery.count>=2`、`aborted(user)` 或用户明确纠正的工单做 `full` 定点，单次 ≤40k，通常只做 1 次。
- 降级顺序：砍 `done` 无异常会话 → summary 50→30→20 条、full 窗口 3→1 → 原始日志只读 P0/P1 → full 2000→800 字、summary 1000→500 字 → 仍超预算则写 `status=partial` 并列出未覆盖项；`degraded` 取值 `drop-low-priority`/`read-30`/`no-raw`/`truncate`/`corrupt`；连续 3 次超 80k tokens 或 12 分钟，下周默认上限下调 20%。
- 候选排序固定 6 级：Ria 自己 → `blocked`/`failed`/`working` 超 2h → `recovery.count>0` 或 `attempts.count>1` → `done` 但有 feedback/追问 → `done` 无反馈 → `cancelled`；同级按 `updatedAt` 倒序，同 executor 合并，超 8 个先砍第 5/6 类并写“跳过 N 个低优先级会话”。
- 报告：YAML front matter `schema: 2`（date/`windowStart`/`windowEnd`/trigger/`runId`/attempt/`workerSessionId`/status）加固定标题（一句话、做对了什么 ≤3、错漏清单、教训 ≤5、对 dsh-ria 的迭代建议 ≤5、memory 候选 ≤3、明日关注 ≤3、覆盖与成本、未覆盖）；正文 ≤200 行 / 30KB；`durationMs`、`compressedBytesRead`、`decompressedBytesRead`、`readCalls` 由宿主 `finish` 按 `run.stats` 覆盖，模型只写 0，不信任估算。
- 落盘命名：`reflections/<forDate>.md`、`.partial.md`、`.manual-HHMM.md`；草稿固定 `runs/<runId>/report.partial.md`；`runId` 为 `refl-YYYYMMDD-<6hex>`；worker 标题 `反思 YYYY-MM-DD`，同日第 2 次起 `反思 YYYY-MM-DD（第N次）`；对外只引用 `finish` 返回的 `reportPath`。原子写（临时文件 + rename + fsync 目录）；`run.json` 保留最近 30 个 run 或 180 天。
- 设置：`settings.reflection` 默认 `{enabled:false, cadence:"daily", time:"23:40", weekday:1, model/provider/reasoningEffort:null}`，时区固定 `Asia/Shanghai`；`time` 用 `/^([01]\d|2[0-3]):[0-5]\d$/`，`weekday` 1–7（1=周一）；非法值整包 400 不部分写入；旧档补默认值、保存保留未知字段；schedule 标题 `Ria: 定期反思`、`target=this_session`，关闭只 `active:false` 不删除，Ria 换会话后按 `scheduleId` 与 `riaSessionId` 重建。
- API：`GET /settings` 返回 `reflection` 与 `reflectionStatus`；`GET /reflection/status` 只读返回 `{lastCompletedDate,lastStatus,lastError,activeRunId,workerSessionId,scheduleId}`；`POST /reflection/run` 注入 `[REFLECTION MANUAL]`（`host_` 前缀，不进 intake），返回 202，已有运行返回 409；运行中 UI 每 10 秒轮询 `GET /reflection/status`，卸载时清理定时器。

## 实现状态

- 服务端与编排（2026-11-14）：6 个只读 worker 工具；`ria_reflect` 五动作 status/begin/dispatch/finish/abort；`reflections/state.json` + `.lock` + `runs/<runId>/run.json`；三重幂等、20 分钟锁 TTL 与接管、attempts、自动重试上限 1 次，没有新增后台 timer。
- 报告校验与落盘：front matter 与固定标题校验；「对 dsh-ria 的迭代建议」存在时必须非空且 ≤5 条；memory 候选 `[target: global|worker:<sessionId>]` 非法时降级 global 并记 warning；三类文件名原子写；只有 complete 推进 `lastCompletedDate`。
- 命名统一（2026-11-16）：标题、`runId`、报告路径与 manual/partial 由 `test/reflection-naming.mjs` 覆盖。
- 安全收缩：worker 用 `agentPreset=minimal` 创建，绑定后 `restrict({allow: []})` 移除全部全局工具，在真实宿主 ToolsService 上实测可见工具恰好 6 个；`ria_spawn` 在 `create` 前预生成 sessionId 并携带 `reflectionRunId`，绑定在 `agent/created` 时安装（该事件在 create 返回前触发）。设计里的 `ria-reflection` preset 并未注册，这是实现替代方案。
- 设置与 schedule：`settings.reflection` 默认值、旧档迁移、未知字段保留；`GET /settings` 返回 `reflection` + `reflectionStatus`，`POST /settings` 整包校验；反思设置里的模型字段会覆盖 `ria_reflect begin` 的 spawn 参数；schedule 为可选注入，缺服务时设置仍保存并给出原因，关闭只暂停不删除，Ria 换会话后重建。
- API 与设置页 UI：「定期反思」段含开关、每天/每周、星期、时间、高级模型字段、「现在启动」与状态行；打开时读 `GET /settings`，运行中每 10 秒读 `GET /reflection/status`；手工验证覆盖开关、改时间、切每周、关闭只暂停、`force` 重跑不覆盖原报告、轮询与定时器清理，源码断言在 `test/reflection-settings-ui.mjs`。
- startup 补跑：enabled、当期未完成、已过点且无 active run 时补最近一次；优先建 90 秒后一次性 schedule，没有 schedule 服务时注入 `host_` 提醒；`state` 记 `lastReminderForDate`/`lastReminderAt`，重复启动不重复提醒。
- 测试：`test/reflection-run.mjs` 覆盖同日 skipped、运行中 locked、force 新 run、非法报告、abort、dispatch 失败与重试上限；`test/reflection-schedule.mjs` 覆盖设置校验正负例、schedule create/edit/pause、换 Ria 重建、202/409、startup 补跑幂等与无 schedule 降级。

## 仍未实现 / 风险

- 报告渲染/归档 UI、微信通知全文未实现（设计只允许发摘要 + 路径）。
- 多天回填未实现：只补最近一次；隔 3 天只补昨天，报告里把更早日期列为 gap，不逐天补。
- `index.jsonl` 趋势索引、`reflections/wiki/` 长期层（规则页、交叉链接、去重、`expired/refuted/superseded` 修剪）属 P3，未实现。
- 窄口径自动写 memory（`settings.reflection.autoMemory`）未实现、默认关闭；启用须同时满足用户当轮明确说“记住/以后都这样/别再”、内容稳定、与 memory 和 manager prompt 都不冲突、单条 ≤200 字且剩余空间 ≥200 bytes、不涉及路由/sessionId/重启审批、报告留追加原文与前后 diff。
- 生效前提：改动需同步到真实 profile 的安装副本并重启 dsh web 才生效；开发验证用 `.verify-home` 或 CDP 注入，不为此改宿主代码。
- 仍有效的待拍板：报告保留期（推荐 180 天，备选 90 天/永久）；worker 超时但仍在跑时是否允许自动 stop 再重试（当前选择不自动停、标 `timed_out` 等用户）；P3 是否用微信推“摘要 + 路径”。
- 结构性风险与缓解：读太多→工具入口限流 + 三层读取 + 固定排序 + 降级；越权→只读 preset/allowlist，不碰 `creds.json`、`audit.jsonl`；模型漏步骤或算错日期→宿主在 `begin` 算好 `forDate`/窗口写进 instruction；spawn 后工具没装上→create 前绑定 + 集成测试断言；并发→文件锁 + live worker 检查；自我表扬→「做对了什么」≤3 条且错漏必须带证据；隐私→0600/不进 git/脱敏；memory 污染→只提议；设置与 schedule 不一致→`state.scheduleId` + 状态查询。
- 能力上限：P0/P1 仍是同一模型按证据模板自查，没有独立审判模型；“只提议”是安全选择而非最优引导（Anthropic 记忆研究：对强模型用死板 prompt 限制“记录动作”是负向约束，Opus 5 平均奖励 0.828→0.594）。

## 现行文档

- API 与设置：`docs/state-and-api.md`（`GET/POST /settings`、`GET /reflection/status`、`POST /reflection/run`）。
- 工具：`docs/tools.md`（`ria_reflect` 五动作、6 个反思读取工具及其参数）。
- 设计与测试：`design-history.md`（Phase 34 反思会话命名与路径统一）、`docs/testing.md`（`reflection-settings-ui` 等覆盖）、实现 `lib/reflection.mjs`、测试 `test/reflection*.mjs`。
- 与代码或上述文档冲突时，以 `lib/reflection.mjs` 与现行文档为准。
