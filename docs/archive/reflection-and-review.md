# Ria 主会话复盘与反思工具试跑（2026-11-11 → 11-14）

> 状态：历史设计（2026-11-11 → 11-14，含主会话复盘与反思工具试跑）／部分实现（反思工具 6 个已实现，试跑两处缺陷已修）／方案未实现（宿主快照与自重启原语、反思默认阈值均无落地记录）
> 现行文档见 [daily-reflection.md](daily-reflection.md)（反思系统与预算）、[tools.md](../tools.md)（工具语义）、[operations.md](../operations.md)（运维）、[DESIGN.md](../../DESIGN.md)（核心设定）。

## 背景与目标

- 复盘对象是 Ria 自身处置：220 个 turn、2026-11-11 09:17 → 11-13 00:41，不含 dsh 宿主代码改动；目标是区分「做错活」与「动宿主」，并落成 prompt、工具语义、宿主能力三类改法。
- 试跑对象是反思系统的 6 个只读工具：用真实日志判断能否写出有信息量的每日反思、输出多大、缺口在哪、默认条数与阈值定在哪。
- 样本：原始 7.94 MB / 3965 个 zstd 帧，逐帧解压为 25.29 MB / 10887 行；`L` 指解压文件物理行号，`Tn` 指 `turn/start` 的 `data.turn`。
- 全量通读无抽样：220 turn（completed 217 / aborted 3）。证据门槛：每条问题至少 1 处「用户原话或报错原文 + 行号」，无证据不进清单。

## 关键决策（含理由）

复盘给出的处置决策与依据：

- 禁止手改 `~/.dsh/sessions/**` 与 `session_projcache`：恢复/回滚只走宿主工具，没有工具就明说做不到并给替代方案。理由是写文件绕过会话日志的多帧 zstd 不变式，代价是两个会话 corrupt、差点不可恢复。
- 重启改用 `systemd-run --user --collect --on-active=N --property=KillMode=process`，重启后 `schedule_create` 自检并回报 PID/空窗/health；该 checklist 目前只在 memory，应上移进 prompt。理由是重启单元原属 dsh-subprocess scope，随 web 关闭被杀，造成 128 s 与 24 s 空窗。
- 派发前三问：目标是否 top-level 且非 archived、是否已有在跑 turn、这活归属谁（在跑/已完成）。理由是三起误派（subagent、归档会话、错 worker）都由用户先发现，返工成本高于一次 `ria_status`/`ria_read`。
- 信息同步与进度更正默认 steer，排队只留给「等当前 turn 结束再做」的下一单。理由是默认 followup 让更正晚一轮生效，用户须二次纠正。
- 自己踩到的崩溃、语法错、工具 bug 必须建工单，禁止静默重试。理由是 `ria_status` 的 TypeError 被绕过后再未修复，同类工单数据一出现即崩。
- 文案类（口号/图标/hero）一次给 5–8 个成型候选，并写明验收维度（押韵、去重字、贴近参考）。理由是口号改了 4 轮、图标「贴近 A3」改了 2 轮，单点微调每轮都全量重出。
- 工具错误要自解释：非法迁移附合法下一状态列表，`executor` 的错误里给出 `self` 示例，`ria_request` 的必填项给可照抄示例。理由是错误只报「不能」，制造了约 1/3 的无效往返。
- 反思默认值下调：`read_tickets` 80 → 20，`full maxChars` 30,000 → 8,000，outbox 50 → 20。理由是 97 张工单取 80 张即 52,202 字符，单这一项就超过 Tier 0 的 20 KB 预算、接近总预算 90k 的 60%。

## 关键机制与数字

- 事件量：user/message 442，其中宿主注入 274（Task intake 107、Worker idle 64、time-context 76、重启恢复 16、ptc-mode 31），真人类 168（含 32 条纯图片/附件）；assistant/message 1158；tool/call 1014，全为 `run_code`；内层 PTC 1159 次（bash 608、ria_read 113、ria_ticket 113、ria_resolve 104、ria_request 87、ria_status 66、ria_memory 30、ria_task 30、compress 19）。

168 条真人消息按主意图单标签归类：

| 类型 | 条数 | 占比 | 特征 |
| --- | ---: | ---: | --- |
| 派工/交付/需求 | 48 | 28.6% | 多为单点小改或对既有任务的追加 |
| 贴图/附件 | 32 | 19.0% | 纯图片或微信 XML，以图代描述 |
| 纠正/否定/报 bug | 26 | 15.5% | 其中 9 条是「上一条没被正确执行」 |
| 配置/运维 | 17 | 10.1% | 重启、push、部署、迁移、恢复 |
| 验收/拍板/选型 | 14 | 8.3% | 常绑上一轮候选集 |
| 调研提问 | 12 | 7.1% | 先答「能不能」，再接「实现之」 |
| 进度追问 | 10 | 6.0% | 「任务状态」「咋没消息了」 |
| 规则/记忆写入 | 6 | 3.6% | 写进 memory 或设计原则 |
| 闲聊 | 3 | 1.8% | hello / hi |

- 26 条纠正里 5 条指向「它/这个/那个 worker」；派工正确率主要取决于「派给谁」，而非「做什么」。纯贴图 32 条（19%）几乎都是以图代描述，处置基本正确。
- 句式可自动化程度：约 55% 可规则化（单动词指令、`把X改成Y`、`看看X`、`顺便/插播` 切分、分号多任务），约 30% 需实体检索（`让XX做YY` 的 XX 消歧、近形词「无人机/无人车」），约 15% 必须绑上一轮候选集（`实现之/可以/上线/保持现状`）。低置信度时应以一句澄清代替猜测：本次 5 次误派的代价都高于一次澄清。
- P0-1 会话 corrupt：T24 L1667 用户要求「把刚才发错的两个session恢复到之前的状态」，Ria 直接重写 `session.v4.jsonl.zstd`，把 168 帧压成 2 帧；T27 L2085 报 `stored session "session-457a5411-..." is corrupt: ... first frame is not exactly one header`；最终靠原始 168 帧截断到 508 行才救回。
- P0-2 重启空窗 128 s（第一次）/ 24 s（第二次）：T42 L2785 用户原话指向「旧进程被杀、新进程没起来、被 watchdog 拉起」；watchdog 日志 20:54:25 停、20:56:32 起；第二次 24 s 发生在无 KillMode 时，第一代曾 3.1 s 健康后仍被 cgroup 回收。
- P0-3 派给不可运行目标：subagent `session-1213b363` 报 `session is not an available top-level session`；归档 worker 73 ms 内 blocked；两次任务静默丢失（T14 L1151、T4 L392）。
- P1：错派给 `session-457a5411` 而非「无人车底商」；插件迁移 13:50/13:52/13:53 三次重启、40+ 次调用仍不生效（缺 `dsh.bundle`，补 `cordis.patch.yml` 后 client bundle 仍不加载）；`ria_status` 抛 `TypeError: (t.updatedAt || t.closedAt || "").slice is not a function`；微信通道看不到 card/回执与 SVG。
- P2：状态机 `cannot move ticket ... from blocked to done` 与 `... from open to done`，只能 blocked→open→working→done；`executor` 只认 `self`；`targetSessionIds must contain at least one session id`；T146 同一 turn 两次同文 `ria_request`。
- 压缩结论：全程 19 次 `compress`，未找到「因压缩丢失用户要求」的直接证据；3 个 aborted turn 中 T99 为用户主动中止、T208 为重启 disposed。T146 同文二次派发在压缩边界附近，无法区分重述与真实重复。
- 根因收敛 6 条：R1 目标消歧缺失、R2 宿主边界不可见（存储格式/cgroup/插件 bundle）、R3 工具语义欠表达、R4 派发前不预检、R5 自我 bug 不建工单、R6 文案类无验收标准。

## 实现状态

- 复盘完成于 2026-11-13，建议分四类（主提示词、工具/错误码、宿主能力、操作习惯），每条附最小验证方式；复盘稿未记录逐条落地结果。
- 可见的局部改进：T93 把「进度/更正类走 steer」落成 memory；T175 已能靠 `ria_status` 正确定位「vggt经验总结」worker；P1-6 的 TypeError 截至复盘时未修，属潜伏缺陷。
- 反思 6 个工具已实现于 `lib/reflection.mjs` 与 `lib/index.js` 接入层，试跑时未同步安装副本；run `trial-1794588724024`，4 个候选会话、0 坏帧。
- 试跑修掉两个真实缺陷：超过 1,000 字的用户消息会让 summary 在第一条就停止（review worker 修复前只有 1 条 user，修复后 3,311 字符、1 条最终答复、2 组工具调用）；`[Worker idle]` 走 `source.kind="user"` 被误算真人消息，改为按宿主通知前缀识别 injected 后，Ria 的 24 条 user 中真人 7 条、注入 17 条。
- 试跑只读日志与 `~/.dsh/state/ria/ria.json`，未建 schedule、未写正式报告、未改 `memory.md` 或 `ria.json`。

工具输出量级（`JSON.stringify` 字符数，非 token）：

| 工具/参数 | 输出字符 | 说明 |
| --- | ---: | --- |
| `ria_reflect_status` | 894 | 4 个候选、limits、memoryBytes、reportPath |
| `ria_reflect_read_sessions` | 482 | 4 个候选，title 为空 |
| `read_tickets` window limit=80 | 52,202 | 窗口内 97 张返回 80 张，truncated |
| `read_tickets` open limit=80 | 4,497 | 非终态仅 5 张 |
| `read_tickets` history limit=80 | 53,340 | 终态 113 张返回 80 张 |
| `read_context` memory | 1,476 | `text` 2,475 字节 |
| `read_context` outbox | 9,971 | 16,138 字节，50 条后 truncated |
| `ria_reflect_report` | 187 | 只返回 path/bytes/sha256 |

- summary 是硬顶 12,000 字符：Ria 用到 12,000（24 user + 6 assistant + 10 tool + 19 thinking，stats 30/588/588/614），worker A 12,000、review worker B 3,311、vggt worker C 6,477；full 硬顶 30,000，Ria 29,717，其余均满 30,000。
- 一天的总量按 4 个会话设计：90k 预算中结构化约 13k、summary 约 33k（Ria 12k + 3×7k）、full 2×8k、余量约 28k；6 个以上 worker 时按 Ria 12k + 每个 6k，最多展开最近使用的 4 个。
- 试跑时默认值未调整：`read_tickets` 仍 80、`full maxChars` 仍 30,000、outbox 仍 50、summary 仍 12,000、maxMessages 60、memory 4 KB、报告正文 30 KB 仅硬顶（目标 4–8 KB）；`memoryBytes` 字段已改为 `memoryChars`，按 Unicode code point 计字符。

## 仍未实现 / 风险

- 宿主缺会话快照/恢复原语（`session/snapshot` + `session/restore`），也缺 `restart self` RPC；这是 P0-1、P0-2 的结构性根因，仅靠 prompt 约束不能消除。
- `dsh plugin doctor`、inbox 撤回 API、`schedule` 删除时撤回已入队投递，均未提供；superagent 插件的 client bundle 在重启后仍不被服务。`schedule` 删除后到点仍投递已在 T59 实见。
- 反思缺 tickets 增量游标（`insideWindow` 只能按 createdAt/updatedAt/closedAt 覆盖窗口），重复反思会重复读同一批 done 工单；`read_sessions` 只有 sessionId/title/running/blank/ticketIds，判断「今天完成没有」必须再 `read_session`。
- summary 按时间顺序消费预算，晚发生的 turn 会被整段丢掉；Ria 与 worker A 都正好停在 12,000，最后一段未进入摘要。注入消息（Ria 24 条 user 中 17 条）与真人抢同一预算。
- summary 的 assistant ref 只指向每 turn 最后一条，读同 turn 更早文本只能用 `from/to`；full 一次吃满 30k，只能定点升级。tool brief 只有参数预览与成功与否，不含结果，定位失败必须回原文。
- 注入识别依赖前缀清单（`[Worker idle]`、`[Task intake]`、`[Queue ready]`、`[Queue blocked]`、`DSH 刚刚重启。`、`SCHEDULE REMINDER`），宿主新增通知文案需同步，否则又会算成真人消息。
- schedule 上下文本轮为空视图，接入后 `kind=schedule` 应返回当天反思任务的 rrule、上次与下次运行。
- 待拍板：候选会话必须在开跑时由编排层预置（`openReflectionRun({candidates})` 与 `ria_spawn({reflectionRunId})` 之外无运行时扩充入口）；`forDate` 与窗口应按本地日历日，试跑用 25 小时 + UTC 日期只为覆盖 16:41Z 的 turn；tickets 默认值是否直接改 `REFLECTION_DEFAULTS.ticketLimit` 并同步 `daily-reflection.md` §4.5/§8.2；summary 是否默认过滤注入；`full maxChars` 是否先降到 8k。
- 长期风险：约 15% 的指令必须绑定上一轮候选集，误派成本高于一次澄清；「无人机底商 vs 无人车底商」这类近形词没有模糊匹配提示；微信通道的 card/markdown 缺失会让用户在主力通道拿不到回执。

## 现行文档

- [daily-reflection.md](daily-reflection.md)：反思系统设计、预算与默认值；§4.5/§8.2 需与 tickets 默认条数同步，`REFLECTION_DEFAULTS.ticketLimit` 是代码侧落点。
- `docs/tools.md`：工具语义与错误码；`docs/operations.md`：重启、部署与运维。
- `DESIGN.md`：项目核心设定；涉及核心设定的改动需先经用户确认。
- 原始记录：本页即合并稿；原 `docs/ria-session-review.md` 与 `docs/reflection_tool_trial.md` 已删除，内容并入本页。
