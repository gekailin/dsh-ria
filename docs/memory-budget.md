# memory.md 容量上限：调研与方案

> **结论先行**：把「4 KB 字节」改成「字符 + 条数 + 单条」的 core 预算，并增加不注入的 archive。建议 **core 2400 字符 / 12 条 / 单条 300 字符**；到 **2160 字符、11 条或任一条达到 270 字符**时先提示归档；硬超限拒绝写入，错误里写清当前值、上限、超出量和可执行的迁移路径。推荐 **方案 C（分层 core + archive）**，core 的计量采用 **方案 B（字符 + 条数）**。
>
> **实现状态（2026-11-16）**：§4 的 core 预算、设置页三项可调、`ria_memory` 的 `list` / `scope=archive` 与读侧告警已落地；代码在 `lib/text-size.mjs`、`lib/memory.mjs`、`lib/index.js`、`lib/reflection.mjs`、`lib/client.js`，测试在 `test/memory-budget.mjs`。真实 `~/.dsh/state/ria/memory.md` **尚未迁移**，本文和代码都没有自动改写它；§5 的迁移步骤仍需人工执行。
>
> 下文保留调研与方案原文作为设计依据；与实际实现不一致处，以本节和 §4.3/§4.4 的「已实现」标注为准。
>
> 调研链接于 2026-11-16 抓取并复核；产品文档会继续变化，数字以链接当前版本为准。

## 1. 现状与问题

### 1.1 现状

| 项目 | 现状 |
|---|---|
| 上限 | `MEMORY_LIMIT = 4096`，按 **UTF-8 字节**计（`lib/index.js:32`） |
| 来历 | 首个 commit `1304513`（2026-11-10）的约定；`docs/design.md:326` 写「0600；上限 4KB；满了先合并，再问用户删」，没有实测推导 |
| 写路径 | `writeMemory()` 在超过 4096 字节时抛硬错误，不截断、不写入（`lib/index.js:2177`） |
| 读路径 | `readMemory()` 直接读全文，没有大小检查（`lib/index.js:2175`）；`managerPrompt()` 每轮把它注入 system prompt 末尾（`lib/index.js:2235-2236`） |
| 反思读取 | `memoryInfo()` 报的是字节数；`readMemoryContext()` 用 `clipChars(text, REFLECTION_DEFAULTS.memoryBytes)`，把 4096 当**字符数**用（`lib/reflection.mjs:814-829`，常量在 `lib/reflection.mjs:33`） |
| 当前文件 | 本机实测：**3724 字节 / 1982 字符 / 11 条 bullet**，已到 4 KB 的 **91%** |
| 最长条目 | `worker-lessons` **519 字符 / 1071 字节**（占全文件 29%）；`restart` **314 字符 / 428 字节**；`worker-routing` **279 字符 / 421 字节** |
| 重复 key | 3 处：`worker-lessons`、`restart`、`worker-precision` 的 key 前缀各写了两遍，共多出 **53 字符** |
| 可见性 | `ria_memory` 只返回 `{ bytes, limit }`（如 `lib/index.js:7140`、`7151`），没有字符数、条数、单条最大值，也没有预警 |

当前 `memory.md` 的实际形态是「11 条规则，其中一条 519 字符的长流程」。这不是 4 KB 能自然容纳的形态：它已经靠中英混排、把长流程压成一段才塞进 91%；再想加一条，就必须先删东西。

### 1.2 六个具体问题

1. **单位不可比：字节不是用户能感知的容量。**
   4096 字节 ≈ **1365 个纯汉字**；同样的 4096 字节可以放 4096 个 ASCII 字符。中文用户写 1982 个字符就可能已经 3724 字节，而英文用户还能写两倍内容。memory 的「满没满」取决于语言和标点，不取决于规则数量。应以 **Unicode code point** 计，与 `reflection.mjs` 的 `charsOf()` 口径一致。

2. **4 KB 是拍脑袋的，不是从上下文预算推出来的。**
   `docs/design.md:326` 只写了结论，没有解释为什么是 4 KB、为什么按字节。后续也没有实测校正。先定单位、再定数字，比继续在 4 KB 上打补丁更重要。

3. **只有硬错误，没有预算视图。**
   写满时直接抛 `memory.md would exceed 4096 bytes; merge or remove entries first`（`lib/index.js:2177`）。错误只给字节，不告诉用户当前几条、最长哪条、超了多少、该往哪里搬；`ria_memory read` 也只显示 `bytes/limit`。结果是用户只看到「满了」，没有可操作的下一步。

4. **读路径可以绕过上限。**
   `docs/design.md:327` 允许用户直接编辑 `memory.md`。手工编辑不受 `writeMemory()` 检查；`managerPrompt()` 又会把全文注入。也就是说，**4 KB 只约束工具写入，不约束手工编辑后的注入**。反思读取的 `clipChars(..., 4096)` / `truncated` 又按字符算，和字节上限不是同一把尺；正常写入路径因为「字节数 ≥ 字符数」暂时没有暴露，但手工编辑或迁移文件时会读到超过 4 KB 的内容，而且可能不标记截断。

5. **没有条数和单条上限，长条目会挤掉多条短规则。**
   一条 519 字符的流程和一条 46 字符的译名约定占的是同一「条」。当前 `worker-lessons` 一条就占 29% 的字节；如果再加入两条同等长度的流程，其他偏好就没有位置。上下文研究（见 §2）还表明，规则条数本身会影响遵循率，不只是总长度。

6. **满了只能删，没有「保留细节」的中间态。**
   design 写的是「满了先合并，再问用户删」。合并适合同主题短规则，不适合「10 条通用铁律」「重启命令的失败模式」这类需要逐条保留的流程。没有 archive，用户只能在「留在 core 挤占每轮上下文」和「删掉以后再也找不到」之间二选一。

## 2. 调研结论

> 证据强度：Letta、Claude Code 是产品文档，代表工程约束而非对照实验；Chroma、Lost in the Middle、FollowBench、MemGPT、Mem0、Zep 是论文/技术报告。它们不是专门为 Ria 做的实验，但足以支持「core 要短、按字符/条数计量、细节放 archive」这三个方向。

1. **上下文变长，模型不会均匀地使用它（Chroma《Context Rot》，2025-07-14）。**
   报告评测了 **18 个 LLM**（含 GPT-4.1、Claude 4、Gemini 2.5、Qwen3）；在 LongMemEval 上，把 **~113k token** 的完整对话与 **~300 token** 的聚焦输入对比，所有模型族在完整输入上都出现明显下降；连「重复单词」这种极简任务，输入变长后也会退化。报告的核心结论是：性能随输入长度增长而不稳定，不能把「窗口够大」当成「可以多塞」。
   **对 Ria 的含义**：memory 是每一轮都注入的 attention 预算，不是数据库。core 应该按「每轮都值得付」的标准控制，而不是按模型窗口的百分比控制。链接：<https://research.trychroma.com/context-rot>

2. **相关信息的位置会影响使用，中间位置最吃亏（Lost in the Middle，TACL 2023）。**
   多文档问答和 key-value 检索都呈 U 形：相关信息在开头或结尾时表现最好，在中间时显著下降。GPT-3.5-Turbo 在多文档问答中，最差位置的表现可以比最好位置 **下降超过 20%**；在 20/30 篇文档的设置里，最差情况甚至低于「不给任何文档」的 closed-book 准确率 **56.1%**。
   **对 Ria 的含义**：memory 目前注入在 manager prompt 末尾（`lib/index.js:2235-2236`），位置本身是对的（近因）；但如果 memory 太长，后面的条目会把前面的条目推到中段，且长段落会稀释每条规则的显著性。应保持短、分节、一条一句，不要把关键规则埋在长流程中间。链接：<https://arxiv.org/abs/2307.03172>

3. **约束越多，逐条遵循率越低（FollowBench，ACL 2024）。**
   FollowBench 含 **820 条指令**、**5 个逐级增加约束的难度级别**，评测了 **13 个**开源/闭源模型；结论是所有模型随约束数增加而下降，GPT-4 平均也只能连续满足 **约 3 条**约束。约束类型里 Situation、Example 尤其难。
   **对 Ria 的含义**：memory 里的每条 bullet 都是一条约束。问题不只是「多少字符」，还有「多少条同时生效」。core 应限制条数，并尽量一条只表达一个规则；不要把 10 条铁律塞成一条 519 字符的长句。链接：<https://arxiv.org/abs/2310.20410>

4. **成熟的记忆块用「字符」而不是「字节」计量（Letta Memory Blocks）。**
   Letta 的 memory block 有 `limit`，文档明确写的是 **in characters**；官方示例把 `human` / `persona` 两个块的 `limit` 设为 **5000 字符**，prompt 里渲染 `chars_current` / `chars_limit` 元数据，让模型自己看到余量。
   **对 Ria 的含义**：字符预算是可解释、可展示的；5000 字符是「单个块」的官方示例，而 Ria 的 memory 是每轮都注入的全局偏好，core 设在 2400 字符比 5000 更保守，留出系统提示词其他部分的余量。链接：<https://docs.letta.com/guides/agents/memory-blocks>

5. **索引和详情要分开：Claude Code 的 memory 只加载前 200 行或 25 KB（Claude Code Docs）。**
   Claude Code 明确建议 **每个 CLAUDE.md 控制在 200 行以内**，理由是「更长的文件消耗更多上下文并降低遵循度」；auto memory 的 `MEMORY.md` 每次对话只加载 **前 200 行或前 25 KB，以先到者为准**，超出部分不加载。它还建议「一条一行，细节移到 topic files」，并在接近上限时提醒缩短；超限写入会成功，但下一次加载会丢掉超出部分并报错让模型重写索引。
   **对 Ria 的含义**：core 应该是**索引/规则**，不是全文；长流程放 topic/archive 文件。Ria 比 Claude Code 更应该严格，因为 Ria 的 memory 是常驻管理者的全局提示，不是按项目加载的文件。另一点是：**不要静默截断**；超限时应在写入时明确拒绝并给出迁移建议，而不是让下一次注入悄悄少一截。链接：<https://docs.claude.com/en/docs/claude-code/memory>

6. **分层记忆是成熟路线：MemGPT 的虚拟上下文，以及 Zep 的时序图谱。**
   MemGPT 把 LLM 上下文当成「主上下文」，把外部存储当成「磁盘」，在主上下文和外部存储之间做虚拟上下文管理，以支持超出窗口的文档和长期对话。Zep 的 Graphiti 则把对话与业务数据做成时序知识图谱；在 DMR 上 **94.8% vs MemGPT 93.4%**，在 LongMemEval 上报告 **最高 18.5%** 的准确率提升，同时延迟降低 **90%**。
   **对 Ria 的含义**：core + archive 不是「降级方案」，而是记忆系统的常规结构。Ria 现在不需要图数据库；按主题分文件的 archive 就足够，重点是把「每轮注入」和「按需读取」分开。链接：<https://arxiv.org/abs/2310.08560>、<https://arxiv.org/abs/2501.13956>

7. **抽取、合并（consolidation）、检索比全量历史更省（Mem0）。**
   Mem0 在 LOCOMO 上相对全上下文基线：LLM-as-a-Judge 相对提升 **26%**（对 OpenAI 记忆），p95 延迟降低 **91%**，token 成本节省 **超过 90%**；图记忆版本再高约 2%。
   **对 Ria 的含义**：不必为了「不丢信息」把全部细节留在 core。把细节放 archive、需要时读，通常比每轮携带全文更省、更稳；前提是 archive 可检索、指针清楚。链接：<https://arxiv.org/abs/2504.19413>

8. **归档需要维护，但不能自动删用户偏好（MemoryBank / A-Mem）。**
   MemoryBank 用 Ebbinghaus 遗忘曲线做「按时间和重要性遗忘/强化」；A-Mem 用 Zettelkasten 式的动态索引和链接组织记忆。两者都说明：长期记忆需要组织、更新和淘汰，不是只追加。
   **对 Ria 的含义**：archive 应按主题分文件、带更新时间和来源；可以标记「长期未用/可能过时」，但**不要自动删除**用户明确写下的偏好。淘汰应先问用户，或至少保留可恢复的备份。链接：<https://arxiv.org/abs/2305.10250>、<https://arxiv.org/abs/2502.12110>

这两篇没有可直接套用的容量数字；引用它们是为了「归档要维护、不要自动删偏好」的原则，而不是用某个数字论证 2400。

**综合**：Ria 的 memory 应被当作「每轮都付的提示预算」：core 用字符 + 条数 + 单条上限控制，archive 承担细节和低频流程；写入时硬拒绝并给出可操作错误，读取时也要有上限和显式告警。研究支持「短 core」，但不支持「为了短而静默丢信息」。

## 3. 方案对比与推荐

| 方案 | 计量与行为 | 优点 | 缺点 | 判断 |
|---|---|---|---|---|
| **A. 维持 4 KB 字节** | 只按 UTF-8 字节；超限硬错误；不分层 | 改动最小；现有行为稳定 | 中英文不公平；无条数/单条上限；无 archive；当前已 91%；读路径可绕过 | 淘汰 |
| **B. 字符 + 条数双预算** | core 按字符 + bullet 条数 + 单条上限；超限硬错误；不强制分层 | 单位可解释；同时约束总长度和碎片化；实现比 C 小 | 仍是单个 blob；长流程会挤掉短规则；没有「保留细节」的位置 | 可作过渡 |
| **C. 分层 core + archive** | core 只放规则/索引，archive 不注入、按需读；core 仍可用 B 的计量 | 最贴合上下文研究；每轮成本可控；细节不丢；可渐进实现 | 需要 archive 读写与指针规范；检索可能漏；迁移要用户确认 | **推荐** |

**推荐 C，但 core 的预算采用 B 的计量**，也就是「分层 + 字符/条数/单条上限」。理由：

- 只做 B 不解决长流程问题：`worker-lessons` 这类 519 字符的条目仍会占 core；把它压到 300 字符以内会丢细节，压不进去就只能删。
- 只做 C 不设硬预算，core 会重新长回去；archive 不能成为「core 可以无限长」的借口。
- A 的字节口径已经被现网数据证明会制造「看似 91%、实际只剩一条空间」的体验，且对中文用户不公平。

**为什么 core 是 2400 字符、12 条、单条 300 字符：**

- 当前 1982 字符 / 11 条。清掉 3 处重复前缀（-53 字符）、把 `worker-lessons` 519 字符降为约 100 字符指针（约 -419）、把 `restart` 314 字符降为约 150 字符（约 -164），core 会落到 **约 1350–1500 字符 / 11 条**，约为 2400 的 56%–63%，留下约 900–1050 字符给后续偏好。这个余量足够加 3–5 条短规则，但不足以再塞一篇长流程。
- 3000 或 4096 字符会让 core 重新拥有「再放两条长流程」的空间；Chroma 和 FollowBench 都说明，长输入/多约束的代价不是线性的。2400 是「比当前多留余量，但不鼓励继续膨胀」的折中。
- 12 条来自当前 11 条 + 1 个新增位；同时也承认 FollowBench 的结论：约束条数本身要受控。建议一条只表达一个规则，合并同主题短条目，而不是把 12 条当软上限无限接近。
- 单条 300 字符约等于 3–5 句中文，足够写一条完整规则；接近 270 字符的通常已是流程/命令/案例，应该进 archive，并在 core 留一行指针。

**不推荐的做法：**

- 不要用「占模型窗口的百分比」定上限。Ria 的 system prompt 还有其他规则，memory 只是其中一段；窗口大不等于这段该大。
- 不要自动把超出部分截掉后继续注入。写入时拒绝、读取时显式告警，比「下次启动少了几条偏好」安全。
- 不要为了省字符把不同规则硬压成一条长句。那会同时增加单条长度和解析难度，遵循率更差。

## 4. 推荐参数

### 4.1 参数表

| 参数 | 建议值 | 单位 | 计数与行为 |
|---|---|---|---|
| `maxChars`（core 总字符） | **2400** | 字符（code point） | 统计 `memory.md` 全文（含标题、空行），去掉末尾换行；达到 2160（90%）先提示 |
| `maxEntries`（core 条数） | **12** | 条 | 只统计顶格 `- ` bullet；标题/空行不算；达到 11 条先提示 |
| `maxEntryChars`（单条） | **300** | 字符（code point） | 统计整行 bullet（含 `- **key**: ` 前缀）；达到 270 先提示 |
| 硬超限行为 | **拒绝写入，不部分写入** | — | 三项任一超限即失败；错误必须给出当前值、上限、超出量、超限条目 |
| 归档触发 | 2160 字符 / 11 条 / 单条 270 字符，或用户说「整理 memory」 | 字符 / 条 | 先提示并给迁移建议；**不自动改写**用户 memory；用户确认后才移动 |
| archive 位置 | `~/.dsh/state/ria/memory-archive/<slug>.md` | —（路径） | 0600；一个主题一个文件；不注入 system prompt |
| archive 读取 | `ria_memory action=read scope=archive path=<slug>`；另加 `action=list` | 字符 | 默认每次返回 4000 字符，超出用 `offset` 续读；只在与当前工单相关时读；不自动注入 |
| archive 单文件软上限 | 16 | KB（1024 字节） | 超过则按子主题拆分；不自动删除；过期内容标记而不是清空 |
| 读路径保护 | 与 core 同一预算 | 字符 / 条 | 手工编辑导致超限时，只注入能完整放入预算的条目，并在末尾加一行显式告警；不静默截断、不无限注入 |
| 可配置性 | 设置页「记忆预算」三项 | 字符 / 条 | 默认 2400/12/300；范围见 §4.3；保存后下一轮生效；Ria 不能通过工具改自己的上限 |
| API 视图 | `ria_memory` 返回 `chars/bytes/entries/maxChars/maxEntries/maxEntryChars` | 字符 / 字节 / 条 | `bytes` 保留用于排查文件大小；`read` 同时返回是否超限、最长条目 key、archive 列表 |

**计数口径的实现建议**：字符数用 code point（`[...text].length`，与 `lib/reflection.mjs:39-44` 的 `charsOf()` 一致），不要用 `String.length`（UTF-16 单元，emoji/部分汉字会算两个）。条数只数顶格 bullet，避免把 markdown 标题和代码块里的 `-` 算进去。

### 4.2 超限错误信息

错误信息至少要回答四个问题：**现在多少、上限多少、超了哪一项、下一步怎么做**。建议格式：

~~~text
memory.md not written: 2430/2400 chars (+30), 13/12 entries (+1), entry "restart" 314/300 chars (+14).
Shorten "restart" or move its detail to memory-archive/restart.md, then retry.
No changes were made.
~~~

要求：

- 三项预算分别列出当前值/上限/超出量，不只报总量。
- 点名超限的条目 key；如果超限来自总字符但单条都合规，明确说「total only」。
- 明确写 **No changes were made**，避免调用方以为部分写入成功。
- 给出具体动作：缩短哪条、移到哪个 archive 文件、怎么查看当前内容（`ria_memory action=read`）。
- 保留 `bytes` 作为附加信息（如 `3724 bytes`），但主判断用字符/条数，避免再次把单位搞混。
- 读取侧超限时不要用同一句「拒绝写入」；应报 `memory.md is over budget; loaded first N complete entries; see ...`，并把告警显示在状态页/工具回执里。

### 4.3 可配置性（已实现）

用户在 2026-11-16 明确要求把条数上限做成设置页可调，因此不再采用「profile 级、隐藏配置」的建议。实际行为：

- 设置页「记忆预算」段三个数字输入：`maxChars` 500–20000 字符、`maxEntries` 1–50 条、`maxEntryChars` 50–2000 字符；输入必须是整数，非法值直接提示且不提交。
- 保存走 `POST /settings` 的 `body.memory`；服务端逐项校验范围，合法值写入 `ria.json` 的 `settings.memory`，下一轮 prompt 生效，不需要重启。
- `GET /settings` 返回 `settings.memory` 与 `settings.memoryStatus`（当前 chars/bytes/entries/最长条目/overBudget/warnings）。
- 设置页同时显示当前用量和百分比；达到 90% 用橙色提示，超限用红色提示。
- Ria 不能通过 `ria_memory` 或其它工具改自己的上限；上限只由用户在设置页（或 profile 配置）决定。
- 仍不建议按会话覆盖：memory 是全局一份，按会话改上限会让「同一条偏好为什么在这个会话不生效」不可解释。

### 4.4 实现状态（2026-11-16）

- **测量**：`lib/text-size.mjs` 的 `measureText(value)` 返回 `{ chars, bytes }`；`chars` 用 `[...text].length`，`bytes` 用 `Buffer.byteLength(text, "utf8")`。预算、archive 分页、反思报告大小都走它。
- **预算**：`lib/memory.mjs` 的 `MEMORY_SETTINGS_DEFAULTS` 为 2400/12/300；`inspectMemory` 统计 chars/bytes/entries/最长条目/超限项/90% warning；`memoryBudgetError` 生成带单位、key、archive 指针和 `No changes were made.` 的错误；`memoryPromptPayload` 处理手工超限的读侧降级。
- **写入**：`RiaStore.writeMemory` 先 `inspectMemory`，`overBudget` 直接抛错，文件不变；`ria_memory` 的 remember/forget 都返回写入后的预算视图。
- **归档**：`RiaStore.memoryArchiveFile/listMemoryArchives/readMemoryArchive`；`ria_memory` 支持 `action=list`、`scope=archive`、`path`、`offset`；archive 不在 manager prompt 中。
- **反思**：`REFLECTION_DEFAULTS.memoryBytes` 改名 `memoryChars`；`ria_reflect_status` 的 `limits.memoryChars` 与顶层 `memoryChars` 同口径；报告/上下文大小统一用 `measureText().bytes`。
- **设置页**：`lib/client.js` 的「记忆预算」段、`settings.memory` / `memoryStatus`、`POST /settings` 校验。
- **测试**：`test/memory-budget.mjs` 锁定「阿汐 2 字符/6 字节、e+U+0301 2/3、😀 1/4、abc 3/3」、三类硬拒绝、90% 预警、bytes 超但 chars 未超允许写入、只数顶格 bullet、手工超限读侧告警、archive 分页/list/非法 path、设置范围校验。
- **线上 memory**：**未迁移**。§5 的步骤仍需用户确认后执行；代码不会自动移动或删除现有条目。

## 5. 迁移步骤

> 以下是迁移步骤。代码侧预算已落地（见 §4.4），但本文没有执行迁移，也没有改线上 memory。迁移前先备份，任何自动改写都要用户确认。

### 5.1 备份与只读审计

1. 备份：`cp -p ~/.dsh/state/ria/memory.md ~/.dsh/state/ria/memory.md.bak-$(date +%Y%m%d-%H%M%S)`。
2. 只读统计：`wc -m -c -l`、`grep -c '^- '`，并列出每行字符数，确认最长条目和重复 key。
3. 不先改文件；先确认哪些条目应该进 manager prompt/代码（见 `docs/memory-audit.md`），哪些留在 memory，哪些进 archive。已在 prompt/代码里逐字存在的规则，优先删除而不是归档，避免模型看到两遍。

### 5.2 清 3 处重复 key 前缀

当前三处是「key 写了两遍」：

- `- **worker-lessons**: - **worker-lessons**...`（多 20 字符）
- `- **restart**: **restart**: ...`（多 12 字符）
- `- **worker-precision**: **worker-precision**: ...`（多 21 字符）

统一改成「一个 key + 正文」，例如：

~~~markdown
- **worker-lessons**: 派活通用铁律（10 条）见 memory-archive/worker-lessons.md；涉及长任务/验证/多文件时先读。
~~~

这一步只改前缀，不删正文；共省 53 字符，更重要的是避免解析器和人把同一个 key 读成两个。

### 5.3 把 `worker-lessons` 降级为一行指针 + archive 详情

1. 新建 `memory-archive/worker-lessons.md`，把当前 519 字符里的 10 条铁律逐条抄进去，保留来源（vggt 42 会话复盘 `SESSION_LESSONS.md`）和更新时间。
2. core 只留一行「什么时候读、去哪读」的指针，例如：

~~~markdown
- **worker-lessons**: 派活通用铁律（10 条）见 memory-archive/worker-lessons.md；长任务、后台化、验证、多文件改动前先读。
~~~

3. 如果其中某条已经进了 manager prompt 或代码（例如「中间产物写工作区」可能已在别处），在 archive 里标「已由 prompt/代码覆盖」，不要重复保留两套措辞。
4. 指针本身不要超过 300 字符；不要把 10 条压缩成一条 300 字符的长句，那等于把长条目问题从 519 变成 300，仍然挤占注意力。

### 5.4 缩短 `restart`

当前 314 字符，核心信息是「先征得同意、用 systemd-run + KillMode=process、汇报 health/HEAD/空窗、预期 4–5 秒」。建议 core 只留：

~~~markdown
- **restart**: 重启前先征得同意；命令、失败模式与空窗数据见 memory-archive/restart.md；完成后汇报 health/HEAD/空窗。
~~~

把 `systemd-run --user --collect --on-active=6s --property=KillMode=process ...`、setsid/nohup 的 128 秒空窗、缺 KillMode 的 24 秒空窗等细节搬进 archive。重启是低频动作，Ria 可以在执行前读一次 archive，不需要每轮都带着完整命令。

### 5.5 收尾与验收

1. `worker-precision` 只删重复前缀，保留 133 字符的正文；`worker-routing` 279 字符已接近单条上限，暂时保留，但下次加路由时优先把旧 sessionId 映射移进 archive 或改成「按会话标题查找」。
2. 重新统计：`wc -m` 应 ≤2400；`grep -c '^- '` 应 ≤12；每行 ≤300；不应再有重复 key。目标可以更严：≤2000 字符 / ≤10 条。
3. 用 `ria_memory action=read` 确认返回 chars/entries/最长条目；用一份临时文件跑一遍超限错误，确认「三项分别报数 + No changes were made」。
4. 代码与文档已落地：`docs/design.md` §8 已改为字符/条数口径；`lib/index.js`、`lib/reflection.mjs`、`lib/memory.mjs`、`lib/text-size.mjs` 已实现；`test/memory-budget.mjs` 覆盖中文/emoji 按 code point、超限不写入、手工超限读取告警、archive 读写与设置范围。尚未执行的是真实 memory 的迁移与观测。
5. 回滚：保留备份；archive 文件是新增内容，删除指针前先确认详情已落盘。`npm test` 验证代码与文档没有回归；迁移后再用 `ria_memory action=read` 复核实际 chars/entries/最长条目。

### 5.6 迁移后的预期形态

迁移后 core 约 1350–1500 字符 / 11 条，archive 至少含 `worker-lessons.md` 与 `restart.md`。这时 memory 的角色从「所有细节的仓库」变成「每轮都该看到的规则索引」：

- core：路由、用户明确偏好、短禁忌、指向 archive 的指针；
- archive：长流程、命令、案例、复盘细节；
- 两者都不自动删除用户写下的偏好；过期内容标记后由用户决定。

如果连 archive 的读写都不想加，退而求其次选方案 B，但仍建议用 **2400 字符 / 12 条 / 300 字符** 这组数字，不要回到 4 KB 字节。
