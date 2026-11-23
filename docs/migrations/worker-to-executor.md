# worker → executor 迁移

> 状态：已完成（四个阶段，均有独立提交）。
> 范围：活代码、prompt、看板文案、state.json / events.jsonl 活数据、对外工具名。
> 不改写：既有 ticket 历史、events.jsonl 历史内容（除键名迁移外）、memory/lessons 文本、reflection 历史报告、`ria-runs/` 运行记录。

## 1. 字段与存储

| 旧键 | 新键 |
|---|---|
| `workers` | `executors` |
| `workerId` | `executorId` |
| `workerSeq` | `executorSeq` |
| `workerLabel` | `executorLabel` |
| `workerType` | `executorType` |

- 写入端只写新键。
- 读取端保留一版兼容：先读新键，缺失时回退旧键，并在一个进程内只 warn 一次（`state.json` / `events.jsonl` / ticket meta / executor record 分别有作用域）。代码中标注 `TODO: remove after the next release`。
- 历史 reflection 报告的 `workerSessionId` 也按同一策略只读兼容。

## 2. 迁移步骤

迁移只处理活数据文件 `state.json` 与 `events.jsonl`，默认目录 `~/.dsh/state/ria`。

```bash
# 1) 只读预演：输出是否会改动，不写文件、不建备份目录
npm run migrate:worker-to-executor -- --dry-run

# 2) 正式迁移：先备份，再原子写
npm run migrate:worker-to-executor

# 自定义目录（例如测试或非默认 DSH_HOME）
npm run migrate:worker-to-executor -- --state-dir /path/to/state --backup-root /path/to/backups
```

也可直接调用 `node scripts/migrate-worker-to-executor.mjs --state-dir ...`。

### 备份

- 首次真正发生改动前，把目标文件复制到 `~/.dsh/state/ria/backups/<YYYYMMDD-HHmmss>/`（可通过 `--backup-root` 覆盖）。
- 备份文件同名：`state.json`、`events.jsonl`；备份目录不入库。
- 第二次执行若已无旧键，则直接返回 `changed:false`，不写文件、不建新备份目录。

### 原子与并发

- `state.json` 整文件解析 → 改键 → 临时文件 + `fsync` + `rename`。
- `events.jsonl` 逐行解析；不可解析行按原字节保留，行序与行数不变。
- 写入前重读目标文件：若运行中的 Ria 已追加/改动，迁移放弃本次写入并报错，避免覆盖并发追加。

### 幂等语义

- 只要任一文件仍有旧键，`changed:true` 并重写。
- 全树已无旧键时，返回 `changed:false`，文件字节不变；连续执行第二次是 no-op。
- 单元测试覆盖：两次运行第二次字节一致、备份存在、旧键 StateStore 可读、JSONL 坏行与行序保留。

## 3. 代码命名

- `lib/core/worker-pool.mjs` → `lib/core/executor-pool.mjs`，`WorkerPool` → `ExecutorPool`。
- `createIdleWorker` → `createIdleExecutor`，`ensureWorker` → `ensureExecutor`，其余 `worker*` 方法、事件、错误码、日志、测试文件同步改名为 `executor*`。
- 旧文件路径不再保留第二套实现；迁移相关文件 intentionally 保留 worker 字样（见残留表）。

## 4. 工具名与 deprecated 别名

| 新名（canonical） | 旧名（deprecated alias） |
|---|---|
| `ria_chat_executor_config` | `ria_chat_worker_config` |
| `ria_executor_report` | `ria_worker_report`、`worker_report` |

- 新名注册在 Chat / Executor 的可见工具面；旧名仍可调用，但不可见于可见工具列表。
- 每次旧名调用都会：
  1. `this.log('warn', ...)`，消息带调用方 sessionId 与 ticketId（若有）；
  2. 向 `operation-events.jsonl` 追加 `{event:"tool.alias_warn", alias, replacement, caller, ticketId}`；
  3. 转发到新 handler。
- 旧名不作为 canonical WorkOrder token；计划文本应使用新名。`test/workorder-tool-names.mjs` 仍把旧 token 当作过期名做负面校验。

## 5. 历史记录

以下内容按“历史不可改写”原则保留：

- `test/fixtures/reflection-report-*.md`：已归档的反思报告，正文与 front matter 保持原样；读取端兼容旧 `workerSessionId`。
- `ria-runs/`、`reports/`：运行时产物与验收报告，不属于活代码/活数据。
- 既有 ticket 的 goal/summary/evidence、memory/lessons 文本：迁移不触碰。

## 6. 验证

```bash
npm test
npm run migrate:worker-to-executor -- --dry-run
```

迁移测试：`test/worker-executor-migration.mjs`；工具别名测试：`test/executor-tool-aliases.mjs`。

## 7. `grep -rni worker` 残留逐条说明

下表覆盖版本库内活代码/文档/测试的每一条残留（按文件聚合，列出具体行号）。
运行时历史 `ria-runs/`、`reports/` 与历史 fixture 按类别说明；本文件自身也是迁移文档，故整体归入“本迁移文档”。

| 文件:行 | 类别 | 保留原因 |
|---|---|---|
| `README.md:10` | 文档 / 向后兼容 | 说明旧工具名仍作为 deprecated alias 保留一版。 |
| `TODO.md:17` | 文档 / 清理计划 | 记录 deprecated 别名的移除触发条件与对象。 |
| `lib/state/migrations/worker-to-executor.mjs:1,10,101,112` | 迁移代码 | 迁移模块名称与日志标识就是 worker→executor 迁移本身。 |
| `lib/state/worker-executor-keys.mjs:1,5,8,9,10,11,12,16,46` | 迁移代码 / 旧键兼容读 | 这里必须知道旧键名；用字符串拼接避免后续机械改名破坏兼容字面量。 |
| `lib/store/store.mjs:6` | 迁移代码 | 导入旧键兼容模块。 |
| `lib/tools/registry.mjs:28,121,123,124` | 向后兼容 | 注册并隐藏 deprecated 工具别名，调用时 warn。 |
| `lib/tools/tool-catalog.mjs:21,26` | 向后兼容 | 列出 deprecated 工具名；TOOL_TOKEN 继续识别旧 token 以支持负面校验。 |
| `scripts/migrate-worker-to-executor.mjs:2,7,23` | 迁移代码 / CLI | 迁移命令入口与日志。 |
| `package.json:21` | 迁移代码 / CLI 名称 | npm script 名保留 worker→executor 迁移语义，调用的是迁移入口。 |
| `test/executor-tool-aliases.mjs:6,15,17,33,34,36,40,48,53,58` | 向后兼容测试 | 覆盖旧工具名可调用、不可见、warn 字段完整。 |
| `test/fixtures/reflection-report-2026-11-14.md:11,31,35,36,39,40,41,64,67,74,76` | 历史记录 | 已归档反思报告，不重写；读取端兼容。 |
| `test/fixtures/reflection-report-2026-11-16-d7c9c2.md:11,27,28,29,31,45,84,85,92` | 历史记录 | 同上。 |
| `test/worker-executor-migration.mjs:10,11,13,23,25,26,30,32,33,37,42,45,58,64,69,77,85,87,101,109,116,120,130,133,137` | 迁移测试 | 故意构造旧键/旧事件名，验证迁移与兼容读。 |
| `test/workorder-tool-names.mjs:33,65` | 向后兼容 / 负面测试 | 断言旧 `worker_report` token 不应出现在 canonical 模板与 WorkOrder 中。 |
| `docs/migrations/worker-to-executor.md:1-本文件末尾` | 本迁移文档 | 文件名、旧键/旧工具名对照表及本残留表本身。 |
| `ria-runs/**`, `reports/**` | 历史记录 / 运行时产物 | 会话与验收历史，不参与改名、不重写；`grep` 全仓时会出现，属于不可变历史。 |

结论：除上表列出的迁移代码、旧键兼容、deprecated 别名、迁移/负面测试与历史记录外，无未说明的 worker 残留。
