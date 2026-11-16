# memory.md 容量与归档

memory.md 是 Ria 每轮都会看到的长期偏好，容量按「核心规则 + 按需归档」设计：core 只放每轮都该遵守的短规则，长流程、命令和案例放进不注入 prompt 的 archive。工具参数与返回见 [tools.md](tools.md#记忆预算与归档ria_memory)。

## 预算

| 项 | 默认 | 可调范围 | 计数口径 |
|---|---|---|---|
| core 总字符 `maxChars` | 2400 | 500–20000 | Unicode code point，统计全文去掉末尾换行 |
| 条目数 `maxEntries` | 12 | 1–50 | 只数顶格 `- ` 开头的行 |
| 单条字符 `maxEntryChars` | 300 | 50–2000 | 整行长度，含 `- **key**: ` 前缀 |

- 单位一律是 code point（`[...text].length`），不是 UTF-16 `.length`，也不是字节；`bytes` 只作附加信息展示。所有判断走 `lib/text-size.mjs` 的 `measureText()`。
- 90% 预警：2160 字符 / 11 条 / 270 字符只返回 `warnings` 和建议归档，不阻断写入。
- 硬超限：三项任一超限即拒绝，**不部分写入**。返回 `ok:false`、`code:memory_over_budget`，消息列出当前值/上限/超出量、最长条目与所有超限 key，并以 `No changes were made.` 结尾；`diagnostics` 带同一组数字和 `overEntryDetails`。
- 手工编辑允许；若超过预算，注入 prompt 时只保留能完整放入的顶格条目，并在末尾附一行告警，不静默截断。

## 写路径

- `action=remember` 追加 `- **key**: text`（无 key 时 `- text`）；`action=forget` 按 key 或文本子串删行。
- `action=replace` 可整体重写：`content`（完整文本，原样写入）或 `entries`（`{ key?, text }` 数组）二选一。一次校验、一次 `writeAtomic`；任一项超限则整次拒绝，旧文件不变。`entries` 每项必须单行、`text` 非空、`key` 不含 `*`；需要多行排版时用 `content`。
- `replace` 只改 core，不删除、不改写 archive。
- 读 `action=read` 返回 `text`、`chars`、`bytes`、`entries`、三项上限、最长条目、`overBudget`、`warnings` 与 `archives`。

## 归档

- 位置：`stateDir/memory-archive/<slug>.md`，目录 0700、文件 0600；一个主题一个文件。slug 以字母或数字开头，只允许 `[A-Za-z0-9._-]`，最长 80 字符，不能含 `..`。
- 单文件软上限 16 KB：超过只提示拆子主题，不自动删除或改写。
- `action=read scope=archive path=<slug>`：默认返回 4000 字符，超出用 `offset` 续读并返回 `nextOffset`/`truncated`/`overSoftLimit`；非法 path 返回 `invalid memory archive path`，不存在返回 `memory archive not found`。
- `action=list` 列出每个 archive 的 slug、字符/字节数、条数、更新时间和是否超过软上限。
- archive **绝不注入 system prompt**，只在相关工单需要时显式读取。core 里只留指向 archive 的一行指针。

## 设置

设置页「记忆预算」只暴露条目数一个输入（1–50），保存只提交 `body.memory.maxEntries`，不会把总字符/单条写成空值。`POST /settings` 仍接受三项完整配置；设置下一轮生效，不需要重启。`GET /settings` 同时返回 `settings.memory` 与 `settings.memoryStatus`（当前 chars/bytes/entries、最长条目、是否超限与预警）。Ria 不能通过工具改自己的上限。

## 为什么是这组数字

- 用字符而不是字节：同样 4096 字节，中文约 1365 字、英文可到 4096 字符；按字节会让「满没满」取决于语言。code point 与反思模块的字符口径一致。
- 2400 字符约为一屏中文规则摘要；再多会挤占每轮上下文。12 条来自「规则条数本身影响遵循率」的观察：与其塞 30 条互相冲突的偏好，不如保留 12 条真正长期有效的。
- 300 字符单条上限逼长流程外置；archive 保留细节，但不参与每轮注入，避免「删掉就再也找不到」。

## 实现与迁移状态

- 已实现：`lib/text-size.mjs`、`lib/memory.mjs`、`lib/index.js` 的读写路径、`lib/reflection.mjs` 的截断口径、设置页与 `test/memory-budget.mjs`。
- 待执行：本机 `~/.dsh/state/ria/memory.md` 仍是旧的 4 KB 字节时代内容，尚未按新预算迁移；迁移步骤是一次性把长流程移到 `memory-archive/`，core 留指针，然后用 `ria_memory action=read` 复核 chars/entries/最长条目。
