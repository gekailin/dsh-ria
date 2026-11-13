# task 命名审计

## 结论

本任务范围内需要清理的现行命名已经清零：

- 归档日志新写入只用 `tickets.log.jsonl` / `tickets-YYYY-MM.jsonl`。旧 `tasks.log.jsonl` / `tasks-YYYY-MM.jsonl` 只在启动迁移、读取兼容和迁移测试里出现。
- 文档里没有再把 `tasks.log.jsonl` 当作现行文件名的地方；`docs/operations.md:92` 明确写的是“启动时一次性改名、读取端兼容”。
- 两处过时的用户可见措辞已改为 ticket：`package.json:4` 的 description，以及 `lib/index.js:4759` 的启动恢复失败提示。

全仓 `grep -RIni "task"`（排除 node_modules、.git、.tmp-repair、.ui-work、.dsh-test、.hero-e2、.npm-cache）清理后命中 576 行。数量不代表残留问题，绝大多数是历史兼容、历史设计资料、通用英文或第三方协议字段。

判定规则：

- **需清理**：把旧 task 模型/旧归档名当作现行名称，且没有兼容用途。
- **历史兼容**：读取旧文件、旧字段、旧 source.kind，或验证迁移的测试夹具；按用户要求不算残留。
- **历史资料**：当时的 task 模型设计、评审、交接记录；保留原文，避免篡改历史。
- **无关同名**：通用英文 “a task”、QQ 绑定接口的 `task_id`、JS 局部变量 `task`、测试里的任意 ID。

## 分类表

| 位置 | 命中 | 类型 | 处理 | 理由 |
| --- | ---: | --- | --- | --- |
| `docs/task-model-design.md` | 328 | 历史设计资料 | 保留 | ticket 改名前的 T1–T28 设计；文件末尾已写明后续统一为 ticket，改词会破坏历史记录。 |
| `docs/system-dispatch-guard.md` | 21 | 历史评审 | 保留 | 记录当时的 taskId 派发守卫方案，不是现行契约。 |
| `docs/ria-session-review.md`、`docs/code-audit.md`、`docs/ticket-queue-design.md`、`docs/superagent-borrow.md` | 10 | 历史/关联资料 | 保留 | 引用旧设计文档名、旧 ticket id 或当时的审计范围。 |
| `docs/DESIGN.md` | 14 | 设计正文 + 历史 Phase | 保留 | 现行设计已统一 ticket；Phase 10/11/20 的 task 是历史阶段记录，:143 是旧归档名迁移说明。 |
| `test/startup.mjs`、`test/task-state.mjs`、`test/archive.mjs`、`test/attention.mjs`、`test/merge.mjs`、`test/intake.mjs`、`test/grants.mjs`、`test/approvals.mjs` | 84 | 测试夹具/迁移覆盖 | 保留 | 故意构造 v1/v2 `taskId`、`tasks[]`、旧 `tasks.*` 文件与 `task_*` ID，验证兼容读取、去重和迁移。 |
| `test/smoke.mjs`、`test/wechat.mjs`、`test/attachments.mjs`、`test/channels.mjs`、`test/ticket-queue-restart.mjs` | 35 | 测试变量/协议 | 保留 | `eventsBeforeTaskDispatch` 等是局部变量名；QQ 测试数据使用平台 `task_id`；不是旧 ticket 字段。 |
| `lib/index.js`、`lib/tickets.mjs`、`lib/grants.mjs` | 48 | 旧字段/旧名读取 + 通用英文 | 保留 | 双读 `ticketId || taskId`、`lastTicketId || lastTaskId`、旧 `tasks*` 归档名、旧 source.kind `ria-task-host`；删掉会读不了旧 ria.json/归档。其余是 “tracked task”“new task” 这类通用英文。 |
| `lib/channels/qq-bot.mjs`、`lib/channels/wechat-claw.mjs` | 21 | 第三方协议/局部变量 | 不改 | QQ 官方绑定接口就是 `task_id` / `create_bind_task`；`withTypingLock(key, task)` 的 task 是回调变量，与 ticket 无关。 |
| `lib/client.js`、`lib/worker-idle.mjs`、`lib/approvals.mjs`、`lib/wechat/service.mjs` | 5 | 通用英文/字段名 | 保留 | `isTask` 是派发 note 的展示开关；其余是注释里的普通英文。 |
| `docs/memory-audit.md`、`docs/channels.md`、`docs/operations.md`、`docs/limitations.md` | 9 | 当前文档 | 保留 | `[Task intake]` 是现行协议文本；QQ 的 `task_id` 是平台字段；operations 是旧归档名迁移说明。 |
| `package.json` | 1 | 测试路径 | 保留 | `node test/task-state.mjs` 是测试文件名，不改测试套件名。 |

## 本次清理

| 位置 | 改动 | 原因 |
| --- | --- | --- |
| `package.json:4` | description 的 “tracks tasks” 改为 “tracks tickets” | 对外包描述仍在用旧术语。 |
| `lib/index.js:4759` | 启动恢复失败提示的 “未完成的 task / Ria 的 task 列表” 改为 ticket | 用户可见告警应使用现行术语。 |

清理前 577 行命中；清理掉 2 行，同时 Phase 30 新增 1 行旧归档名兼容说明，净为 576 行。

## 归档名核对

- 新写入：`lib/index.js` 的 `ticketLogFile('tickets.log.jsonl')` 与月度 `tickets-YYYY-MM.jsonl`。
- 旧名读取：`LEGACY_TICKET_LOG`、`LEGACY_TICKET_LOG_PREFIX`、`TICKET_LOG_PATTERN`，以及 startup 的一次性 rename。
- 测试：`test/archive.mjs` 显式写旧 `tasks.log.jsonl` / `tasks-2023-12.jsonl` 验证迁移与去重。
- 文档：`docs/operations.md:92` 与 `docs/DESIGN.md:143` 都只把旧名描述为迁移来源。

## 验证

~~~bash
node test/archive.mjs
node test/board.mjs
npm test
~~~

归档名迁移与看板分页分别由 archive、board 覆盖；全量测试见本次提交说明。
