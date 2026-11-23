# Worker Report — ticket_mwsv7f7f_9458eb6cef

- 工单: 协管会话标题保真（A）+ 反思 worker 生命周期（B）+ 413 取证（C）
- Worker: session-82de7705-d23f-4eb6-8f62-160ae70568d9
- 分支/工作区: `exp` / `/home/gkl/Desktop/vibe_proj/dsh-ria`
- 未重启、未部署；只改代码、测试与本报告。

## 结论摘要

| 项 | 结果 |
|---|---|
| A 协管会话不再被自动改名 | ✅ co-managed 跳过 rename/seq 分配，展示名走 `workerLabel` |
| A 自建 worker 命名 | ✅ 仍为 `Ria Worker NN` 并调用宿主 rename |
| A 恢复标题 | ✅ `session-457a5411` = 「众源BEV新」（正规 session/rename 通道，seq 17932） |
| A 核查 `session-3315a7c9` | ✅ 当前仍为「Ria 文档」，未被改，无需恢复 |
| B 每次反思新建 worker | ✅ `Ria Reflection Worker N`，`reflectionSeq` 持久化递增 |
| B 终态归档 / 幂等 | ✅ done/failed/cancelled 触发；重复触发返回 already-archived |
| B 旧常驻 worker（seq 2） | ✅ 首次运行时归档一次并写 `reflection.worker.legacy.retired` |
| B 建 worker 失败回退 | ✅ 复用 idle reflection worker，写 `reflection.worker.reuse_fallback` |
| C 413 取证 | ✅ 已记录事件数/大小/413 原文/建议；C 部分 0 代码改动 |
| 测试 | ✅ `npm test`：108 passed, 0 failed, 108 total（基线 106） |

## A. 协管会话不得被改名

### A-1 根因（file:line）

旧代码 `lib/core/controller.mjs`（HEAD `d0edb03`）：

- `lib/store/store.mjs:102-120` `syncCoManagedWorkers()` 把 `kind=co-managed` 的会话**注入** `state.data.workers`，字段来自协管注册的 `titleSnapshot`；`workers()`（`store.mjs:360-362`）会返回它。
- `lib/core/controller.mjs:2457-2464` `renameRoleSessions()` 遍历 `state.workers()`，对没有 `seq` 的条目调用 `nextWorkerSeq()` 并 `sessionController.rename(...)`。协管会话永远没有 `seq`，于是被当成新 worker 命名。
- `lib/store/store.mjs:122-130` `controlOutput()` 又把 co-managed 从持久化 `workers` 中过滤掉，导致重启后 `seq` 丢失；每次启动都重新取号，所以标题依次变成 `Ria Worker 31/32/33`（本次现场又变成 38）。
- 自建 worker 的正规路径是 `createIdleWorker()`：`controller.mjs:808-828`（旧行号）生成 `Ria Worker NN` 并通过 `createSession()` 的 `sessionController.rename`（`controller.mjs:1516-1531`）落标题。这条路径本身没问题。

### A-2 修复

- `lib/core/controller.mjs:91-104`：新增单一命名函数 `roleWorkerTitle(workerType, seq)` 与展示函数 `workerDisplayLabel(worker, fallbackTitle)`；创建、启动迁移、配置视图共用前者。
- `lib/core/controller.mjs:842-849`：`createIdleWorker` 同时写 `workerLabel` 并继续 rename。自建 worker 行为不变。
- `lib/core/controller.mjs:2607-2614`：`renameRoleSessions` 对 `isCoManaged(worker)` **直接 continue**——不取号、不 rename；只有自建 worker 才分配 `seq` + `workerLabel`。
- `lib/store/store.mjs:111-114`：co-managed worker 记录新增 `workerLabel`（= 协管注册标题），`title` 保留兼容；`store.mjs:323-324` 读取时规范化，缺失即回落。
- 展示路径改用 `workerLabel`：`controller.mjs:802`（ticket watch 标题）、`:3606`（协管 worker view）、`:4488-4507`（`workerConfigView`）；老记录无 `workerLabel` 时回落到 projection title / 既有 `title` / `Ria Worker NN`。

### A-3 测试

新增 `test/co-managed-titles.mjs`，覆盖：

- 协管会话登记 → Advisor 规划 → 派单：`session/rename` 从未以该会话为参数，projection title 仍为「众源BEV新」，worker 记录 `kind=co-managed`、`workerLabel=众源BEV新`、无 `seq`。
- 再跑 `renameRoleSessions()`（模拟重启迁移）：仍然不 rename、不消耗 `meta.workerSeq`、标题不变。
- 自建 worker：`Ria Worker 1` / `Ria Worker 2`，均调用 rename 且 `workerLabel` 与标题一致。
- worker-config 列表展示 `workerLabel`；缺失 `workerLabel` 的历史记录仍能回落。

### A-4 标题恢复（正规通道）

使用宿主 `sessionController.rename` 的 HTTP 载体：

```text
POST http://127.0.0.1:3080/api/session/rename
{"type":"client-request","rpcId":"req-rename-4","method":"session/rename",
 "payload":{"args":{"request":{"sessionId":"session-457a5411-daae-4f2f-a444-04607cd69e5c","title":"众源BEV新"}}}}
→ {"type":"server-response","result":{"ok":true,"value":{"title":"众源BEV新","seq":17932}}}
```

| 会话 | 恢复前最新 title（session/title 事件） | 恢复后 | 说明 |
|---|---|---|---|
| `session-457a5411`（众源BEV新） | `Ria Worker 38`，seq 17895，time 1795414581940（2026-11-23 14:16:21 +08） | `众源BEV新`，seq 17932，time 1795414687819（14:18:07 +08） | 原始用户标题在 seq 2748 就是「众源BEV新」 |
| `session-3315a7c9`（Ria 文档） | `Ria 文档`，seq 516，time 1794465497440 | 未改动 | 没有被改成 `Ria Worker NN`，无需恢复 |

协管注册：`~/.dsh/state/ria/co-management.json` 中该会话的 `titleSnapshot` 本来就是「众源BEV新」，恢复后仍一致，未手改注册文件。

> 环境观察（未改状态文件）：14:15 的宿主重启后，`state.json` 的 `coManagement` 数组为空（`co-management.json` 仍有该 watch）。这是宿主重启期状态落盘问题，不属本单代码改动；本单未写任何 Ria 状态文件，也未在界面/会话上下文里操作。
>
> 注意：当前运行的进程仍是旧代码（未重启、未部署），所以本单只能保证「代码已修 + 现场标题已恢复」；下次重启后新代码不会再改名。

## B. 每次反思用新建 reflection worker

### B-1 位置

- 入口：`lib/index.js:4448` `startReflectionRun()` → `controller.requestTicket(..., {mode:'reflection'})` → `controller.dispatchTicketReserved`（`controller.mjs:5431` 调用 `ensureReflectionWorker`）。
- 复用逻辑：旧 `ensureReflectionWorker` 先选 idle reflection worker 再创建（旧 `controller.mjs:2276-2290`）。
- 计数器：`lib/store/store.mjs:371-383` `nextReflectionSeq()`（key `meta.reflectionSeq`，每次 +1 后立即 `save()`）。
- 终态落点：`lib/core/controller.mjs:606-620` `onTicketTransition`（`TERMINAL = done/failed/cancelled`）。

### B-2/B-3/B-4 修复

- `controller.mjs:2310-2345`：`ensureReflectionWorker` **不再复用**，每次 `createIdleWorker` 新建 `Ria Reflection Worker N`；创建失败时调用 `findIdleReflectionWorker` 回退，写事件 `reflection.worker.reuse_fallback`（payload 带 `runId`=反思 ticket/run、`workerId`、`error`）。
- `controller.mjs:2350-2373`：`retireLegacyReflectionWorker` 找到 `workerType=reflection` 且 `seq=2` 的旧常驻 worker，归档一次，并持久化 `meta.legacyReflectionWorkerRetiredAt`；写 `reflection.worker.legacy.retired`。
- `controller.mjs:2376-2419`：`archiveReflectionWorker` 幂等（已在归档集 → `already-archived`；并发同 id 复用同一个 promise；宿主失败只记事件不抛）。成功后移除 binding 并写 `reflection.worker.archived`。
- `controller.mjs:647` + `:2421-2434`：`onTicketTransition` 进入终态时仅对 reflection ticket 排队归档；`flushReflectionArchives()` 供测试/调用方等待。
- `store.mjs:385-390`：新增 `setMeta()` 持久化一次性迁移标记。

### B-5 测试

新增 `test/reflection-worker-lifecycle.mjs`：

- 旧 seq 2 常驻 worker 首次运行被归档一次；再次调用 `retireLegacyReflectionWorker` 不重复归档。
- 连续两次 `ensureReflectionWorker` 得到不同 sessionId，seq 3 → 4，`state.json` 与重新加载的 `StateStore` 都读到 `reflectionSeq=4`。
- 宿主 `create` 抛错时回退复用 idle reflection worker，`reflection.worker.reuse_fallback` 含 runId/workerId/error，run 不中断。
- 通过 `startReflectionRun` 起两次反思（11-23 / 11-24），两次 dispatch 的 worker sessionId 不同；`ria_worker_report(done)` 后 `flushReflectionArchives()` 归档；重复终态钩子/重复 `archiveReflectionWorker` 幂等。

另外同步了 `test/dispatch-reflection-failures.mjs` 的场景 2：反思不再复用「已有 tagged reflection worker」，改为断言新 worker 仍是 reflection 且无标签（与 B 的新语义一致）。

## C. 413 Request Entity Too Large（只记录，未改代码）

### C-1 现场数据

`session-edd7b6d7-5f43-4c54-bb36-a182348ef3c6`（标题「Ria 开发」）：

| 指标 | 值 |
|---|---|
| 事件条数 | **95,486** 条（`zstd -dc ... | wc -l`） |
| 日志解压后大小 | **348,677,414 B** ≈ 332.5 MiB |
| 压缩落盘大小 | **80,840,658 B** ≈ 77.1 MiB（`session.v4.jsonl.zstd`） |
| 触发工单 | `ticket_mwsv4wfo_8709636409`（turnId 122）、`ticket_mwsv5lvp_9e0ceecc2c`（turnId 123） |
| 证据文件 | `~/.dsh/state/ria/router-events.jsonl:4884` 与 `:4903` |

### C-2 413 原文

```text
INVALID_REQUEST: server_error: 413 Request Entity Too Large: <html> <head><title>413 Request Entity Too Large</title></head> <body> <center><h1>413 Request Entity Too Large</h1></center> <hr><center>openresty</center> </body> </html>
```

（failureCode=`turn_failed`，blocked=true，worker=`session-edd7b6d7`；另一处来自 compaction/end 的同类错误见 `workers/runs/session-c63157e7.../event-56206.json`。）

### C-3 建议（未实施）

1. **执行器侧上下文上限**：协管/worker 派单前检查会话事件数与解压体积（如 > 2 万事件或 > 64 MiB 直接拒绝或要求确认），把「长会话当执行器」变成显式拒绝而不是等 413。
2. **上下文压缩/截断策略**：对超大会话只注入最近窗口 + 摘要（compaction），不要整段历史随请求发送；413 时自动降级为「摘要 + 最近 N 轮」重试一次。
3. **协管类型分级**：把协管会话标为 `observer` / `executor` 两类，默认 observer 不接重活；executor 必须有体积预算。
4. **可观测性**：把 413 归类为 `context_too_large` 失败码，报告中直接给事件数/体积，避免和普通 turn failure 混在一起。

> C 部分只读日志统计与取证，未修改任何代码、未清理/截断该会话。

## 测试与提交

```text
$ npm test
run-tests: 108 passed, 0 failed, 108 total (19.6s)
```

基线（改动前）：`106 passed, 0 failed, 106 total`。

提交（显式路径）：
- `3264267` — A+B 代码与测试
- 本报告提交（紧随 `3264267` 之后，最终 hash 见 `worker_report`）

工作区说明：仓库本来就有未跟踪的 `docs/icon-*` 与 `reports/ticket_mwsv1mnc_362c9d9c9d-acceptance.md`（前者是历史产物，后者是其他工单报告），本单未触碰、未提交。
