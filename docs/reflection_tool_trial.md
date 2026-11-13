# 反思读取工具试跑

本文记录 2026-11-14 对反思系统 6 个只读工具的一次真实日志试跑：工具是否够写出有信息量的每日反思、输出多大、缺口在哪、默认条数和阈值应该怎么定。

试跑只读真实会话日志与 `~/.dsh/state/ria/ria.json`，没有创建 schedule，没有写正式报告，没有改 `memory.md` 或 `ria.json`。代码是工作区里的 `lib/reflection.mjs` 与 `lib/index.js` 接入层，未同步安装副本。

## 0. 结论

1. **够用，但只到“发生了什么”这一层。** summary 能回答：用户提了什么、Ria 决定了什么、派给了谁、最后交付了什么、哪些还没收口。Ria 主会话的 7 条真人消息、6 条最终答复和 10 组工具调用在一次 12,000 字符的 summary 里全部出现。
2. **不够单独写“为什么失败/错在哪”。** summary 的 tool brief 只有工具名、成功与否、参数字符数和参数预览；thinking 只有 80 字预览。要定位一次具体失败，必须用 `mode=full` + `refs` 或 `from/to` 回读原文。
3. **试跑发现两个真实缺陷，已修：**
   - 一条超过 1,000 字的用户消息会让 summary 在第一条就停止，后面的 tool/assistant 全部丢失（review worker 原表现是只有 1 条 user）。修复后同一会话得到 3,311 字符、1 条最终答复和 2 组工具调用。
   - `[Worker idle]` 走的是 `source.kind="user"`，原来被算成真人消息。现在按宿主实际通知前缀识别为 injected；Ria 的 24 条 user 中真人 7 条、注入 17 条。
4. **默认 `read_tickets` limit=80 太大。** 窗口内 97 张工单取 80 张是 52,202 字符，单这一项就超过 Tier 0 的 20KB 预算，也接近总预算 90k 的 60%。建议 window/history 默认 20，open 默认 20；先读 open/blocked，再按需读历史。
5. **一天的总量建议按 4 个会话、约 35k summary + 15k 结构化 + 最多 20k full 来设计。** 6 个会话仍用 12k/会话会顶到 90k 上限。

## 1. 试跑设置

- 运行窗口：`2026-11-12T15:52:04.024Z` → `2026-11-13T16:52:04.024Z`（25 小时）。
  - 用 25 小时是为了把 review worker 在 16:41Z 的完整 turn 纳入；真实每日反思应按本地日历日 00:00–24:00，`forDate` 也必须用本地日期。
- run：`trial-1794588724024`，4 个候选会话，summary 默认参数，随后对每个会话末尾的 tool/assistant ref 做一次 full。
- 会话：

| 会话 | 角色 | 日志大小 | 事件数 | 坏帧 |
| --- | --- | ---: | ---: | ---: |
| `session-56448aa3-1d10-4277-96ed-c156792dbdd8` | Ria 主会话 | 13,149,241 B | 17,018 | 0 |
| `session-3315a7c9-8e1d-41b5-9cdf-cb3e025ebed9` | dsh-ria worker A | 6,413,494 B | 5,852 | 0 |
| `session-61e12887-c6b9-4cae-bd16-f35f490b2b12` | review worker B | 675,477 B | 479 | 0 |
| `session-f7252a16-c976-48c6-82bf-878f2f6c2cbb` | vggt worker C | 28,328,591 B | 29,042 | 0 |

日志路径：`~/.dsh/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`。

## 2. 每个工具的输出字符数

“字符数”是工具返回值 `JSON.stringify` 后的长度，不是 token。status/sessions 的 title 在试跑里为空，真实标题会多几十到一百字符。

| 工具 | 参数 | 输出字符 | 说明 |
| --- | --- | ---: | --- |
| `ria_reflect_status` | 无 | 894 | 4 个候选、limits、memoryBytes、reportPath；title 为空 |
| `ria_reflect_read_sessions` | candidates | 482 | 4 个候选，无 title/lastUsedAt 时 |
| `ria_reflect_read_tickets` | window, limit=80 | 52,202 | 窗口内 97 张，返回 80 张，truncated=true；平均 653 字符/张 |
| `ria_reflect_read_tickets` | open, limit=80 | 4,497 | 非终态 5 张，平均 899 字符/张 |
| `ria_reflect_read_tickets` | history, limit=80 | 53,340 | 终态 113 张，返回 80 张；平均 667 字符/张 |
| `ria_reflect_read_context` | memory | 1,476 | `text` 2,475 字节，未截断 |
| `ria_reflect_read_context` | outbox | 9,971 | 16,138 字节，50 条后 truncated=true |
| `ria_reflect_read_context` | schedule | 0 | 本轮未接 schedule，返回空视图 |
| `ria_reflect_report` | 5,950 B 报告 | 187 | 只返回 path/bytes/sha256；报告正文由模型写 |

### read_session（summary / full）

| 会话 | summary 字符 | summary 条目 | stats（messages/toolCalls/toolResults/thoughts） | full 字符 | full truncated |
| --- | ---: | ---: | --- | ---: | --- |
| Ria | 12,000 | 24 user + 6 assistant + 10 tool + 19 thinking | 30 / 588 / 588 / 614 | 29,717 | true |
| worker A | 12,000 | 11 user + 5 assistant + 6 tool + 16 thinking | 16 / 427 / 427 / 450 | 30,000 | true |
| review worker B | 3,311 | 3 user + 1 assistant + 2 tool + 3 thinking | 4 / 50 / 50 / 48 | 30,000 | true |
| vggt worker C | 6,477 | 10 user + 2 assistant + 4 tool + 14 thinking | 12 / 72 / 72 / 69 | 30,000 | true |

- Ria 和 worker A 都正好用到 12,000 字符上限，summary 被截断；这说明默认 `summaryChars=12000` 对活跃会话是“刚好不够”。
- full 的 30,000 字符同样是硬顶。试跑对末尾 2–3 个 ref 做 full，Ria 仍到 29,717，worker A/B/C 都到 30,000，说明 `fullChars=30000` 对 10 分钟以上的 turn 也偏小；真正的问题是 full 应该少读几个 ref，而不是把上限继续抬高。

## 3. 内容质量：能写出什么

### 3.1 Ria 主会话

summary 的 24 条 user 中，7 条是真人：

- “hi”
- “新开一个worker，读一下ria主会话的日志，看看ria有哪些问题，提出改进建议；顺便总结一下用户给ria发的消息都有哪些类型和句式”
- “第一条具体怎么改？”
- “只做P0兜底，时间改成60秒”
- “关注session-c6be1f4c-a20c-4f1a-892f-1e0e6e341bea的任务；有需要审批的你可以给它批”
- “设置页面的‘微信 Claw 图片’区域不需要，都打开就行了”
- “ria，我和你探讨一个问题，假如我有一个任务交给你……把它分解为多个并行的实验，或者是串行的……”

其余 17 条是 `[Task intake]`、`Time sampled while preparing turn …`、`[Worker idle]`、`[Task intake reminder]` 等宿主注入。**用户意图、决策变化、纠正和未完成项都能从摘要里读出来**，例如：

- 先要求“只出方案/只记录”，后面改为“直接做实验”或“开工”；
- 对“第一条”的追问、把 60 秒兜底作为明确验收；
- 要求关注某个 worker 并代批审批；
- 设置页 Claw 图片开关的删除。

summary 里的 assistant 是每个 turn 最后一条文本，正好是给用户的结论；tool brief 能看到“Read review worker result”“Compress …”这类动作，但看不到结果内容。这对“今天推进了哪些事”足够，对“为什么 compress 失败、失败后怎么改的”不够。

### 3.2 worker 会话

- worker A：README 重写任务，从“只出草稿”到命名定稿、再到候选清单，5 条最终答复都在；能看出用户对英文名的纠正和“Just ask for Ria”的定稿。
- review worker B：修复后得到任务、执行过程、最终报告（`a99da52`）和 2 组工具调用；修复前只有一条被截断的任务，完全看不出是否完成。
- vggt worker C：chunk BA 方案 → 用户拍板 → 实现，2 条最终答复和 4 组工具调用都在；能看出任务从“只写方案”转成“直接做实验”。

### 3.3 full 能补什么

full + refs 能拿到：

- 工具调用的完整参数和工具结果原文（summary 只有参数预览）；
- thinking 的完整文本（summary 只有 80 字预览）；
- 同一 turn 内被 summary 折叠掉的更早 assistant 文本（但 summary 的 assistant ref 只指向最后一条，取回更早文本要用 `from/to` 数字窗口）。

试跑中 full 最有用的场景是“summary 里看到某个工具调用可疑，按 ref 展开看它的输入输出”。但 full 一次就吃满 30k，所以只能做定点升级，不能当作默认读取方式。

## 4. 缺口清单

1. **tool brief 不含结果。** `brief.preview` 是参数或 call 的单行预览，不是 result。summary 看到 “run_code ok, 114,654 chars”，但不知道它产出了什么。需要 full + ref 才能读结果。
2. **summary 按时间顺序消费预算，晚发生的 turn 会被整段丢掉。** Ria 和 worker A 都正好停在 12,000 字符，最后一部分 turn 没有进入 summary；反思如果只看 summary，会漏掉当天最后做的事。
3. **注入消息占预算。** Ria 24 条 user 中 17 条是注入；`[Task intake]` 和 `Time sampled` 重复且长。它们对“真人意图”价值低，却和真人消息抢 12k 预算。
4. **`read_tickets` 默认 80 太大。** window 97 张取 80 张 = 52,202 字符；其中 92 张是 done/cancelled，真正需要行动的只有 5 张。默认应该先读 open/blocked。
5. **tickets 缺少“只读今天变化”的游标。** `insideWindow` 用 createdAt/updatedAt/closedAt 判断，能覆盖窗口，但没有“自上次反思以来”的增量；重复反思会重复读同一批 done 工单。
6. **`read_sessions` 只有元数据。** 只有 sessionId/title/running/blank/ticketIds，没有 lastTurn 结果或最后一句话；要判断“这个 worker 今天到底完成没有”必须再 `read_session`。
7. **`[Worker idle]` 一类注入的识别依赖前缀。** 已覆盖宿主当前实际发送的 `[Worker idle]`、`[Task intake]`、`[Queue ready]`、`[Queue blocked]`、`DSH 刚刚重启。`、`SCHEDULE REMINDER`；以后新增通知文案要同步这个列表，否则会被算成真人消息。
8. **schedule 上下文为空。** 本轮没有 schedule 编排，`kind=schedule` 返回空视图，符合当前范围；接 schedule 后需要返回当天反思任务本身。
9. **full 的 assistant 定点升级不完整。** summary 只保留每 turn 最后一条 assistant 的 ref；要读同 turn 更早的 assistant 文本只能用 `from/to`，不能只靠 refs。这是 summary 折叠语义的直接结果，文档和提示词都要写明。
10. **outbox 50 条约 10k 字符。** 对反思足够，但会占掉 1/9 总预算；多数条目是旧的已送达通知，建议默认 20 条或只取窗口内未送达+pending。

## 5. 建议的默认条数与阈值

按“4 个会话、1 次 full 升级”的典型一天估算：

| 项目 | 当前默认 | 试跑实际 | 建议 |
| --- | --- | ---: | --- |
| `read_tickets` window/history limit | 80 | 52,202 / 53,340 字符 | **20**（约 13k），最多 40；先读 open/blocked |
| `read_tickets` open limit | 80 | 4,497 字符 | 20 足够 |
| `read_sessions` candidates/recent | 20 | 482 字符 | 保持 20 |
| `read_session` summary maxChars | 12,000 | 12,000（Ria/A 都截断） | Ria 12k；worker 8k；总预算 35k |
| `read_session` summary maxMessages | 60 | 30 / 16 / 4 / 12 | 保持 60，实际由字符预算先触发 |
| `read_session` full maxChars | 30,000 | 29,717–30,000 | 8k/次，最多 3 次；总计 ≤20k |
| `read_context` outbox limit | 50 | 9,971 字符 | 20（约 4k） |
| `read_context` memory | 4 KB | 2,475 B | 保持 4 KB |
| `report` 正文 | 30 KB 硬顶 | 5,950 B 示例 | 目标 4–8 KB，30 KB 只做硬顶 |

一个可执行的 90k 预算分配：

- 结构化：status 1k + sessions 0.5k + tickets open 5k + memory 2.5k + outbox 4k ≈ 13k；
- summary：Ria 12k + 3 个 worker × 7k ≈ 33k；
- full：2 次 × 8k = 16k；
- 余量：约 28k，用于 tickets window 补充、更多 worker 或报告草稿。

如果当天有 6 个以上活跃 worker，建议按“Ria 12k + 每个 worker 6k”分配，超过 6 个只读最近使用的 4 个，其余用 `read_sessions` 标题让模型决定是否值得展开。

## 6. 假设与需要拍板的点

1. **候选会话由编排层预置。** 本轮没有“添加候选”的工具；`openReflectionRun({candidates})` 和 `ria_spawn({reflectionRunId})` 之外，没有运行时扩充候选的入口。真实编排必须在开跑时把 Ria 主会话 + 当天活跃 worker 放进 `candidates`，否则反思 worker 只能读自己。
2. **本地日期。** 试跑为了覆盖跨午夜 turn 用了 25 小时窗口，`forDate` 也临时用了 UTC 日期；真实实现应按本地日历日计算 `forDate` 和 window，否则报告日期会和用户认知差一天。
3. **tickets 默认值是否直接改代码。** 本文只给建议；如果确认，下一轮把 `REFLECTION_DEFAULTS.ticketLimit` 或工具默认从 80 调到 20，并同步 `docs/daily-reflection-design.md` 的 §4.5/§8.2。
4. **summary 是否过滤注入。** 当前保留注入并标记 `injected=true`，让模型自己判断；另一种做法是 summary 默认跳过 `[Task intake]`/`Time sampled`，只在 full 里保留。后者省预算但会丢掉“宿主提醒了几次”的线索，需要拍板。
5. **full 的默认 maxChars。** 30k 对单次定点升级太大，对完整 turn 又不够；建议先降到 8k，由编排层决定是否做第二次。
6. **schedule 上下文。** 接 schedule 后 `kind=schedule` 应返回当天反思任务（rrule、上次运行、下次运行），本轮按空视图处理。

## 7. 复现

试跑脚本在工作区未跟踪的 `.reflection-work/trial.mjs`，读取真实日志后输出 `trial-summary.json` 与 `trial-digest.json`。脚本不写入 `~/.dsh/state/ria` 的正式目录（stateDir 用 `reflections-trial`），不修改任何日志、`ria.json` 或 `memory.md`。

验证命令：

```bash
node --max-old-space-size=6144 .reflection-work/trial.mjs
node test/reflection.mjs
npm test
```

试跑后临时目录可以删除；本文的数字来自上述脚本在 2026-11-14 的输出。
