# TODO

## 一次性迁移与 deprecated 别名清理（v2 → state）

- **已完成**：一次性命名/领域迁移代码、启动调用、迁移脚本与单测已删除；运行态读已纯 SQL，domain 读不再回退 legacy JSON。
- 剩余文件清理：`v2.json.bak-*`、旧迁移备份目录、旧 `ria-backup-*` 等历史文件在确认无回滚需求后人工清理；本票未删除这些文件。
- `v2.json.bak-*` 清理时机：连续一版启动未再产生新备份且无回滚需要；不要按固定日期清理。
- 同批清理 deprecated 工具名别名（不按日期，按触发条件）：
  - 对象：`lib/tools/registry.mjs` 的 `aliasesFor`（L114-122）与 `isDeprecatedToolAlias`（L27），以及 L125-138 注册的旧名：`chatbot_*`、`chat_*`、`ticket_*`、`sage_*`、`lesson_*`、`session_*`、`worker_report`。
  - 触发条件：`ria_*` 新名已在线上稳定运行一段时间，且 `operation-events.jsonl` 中 `tool.alias_warn` 不再出现旧名调用（无新增 alias 记录）。
  - 清理内容：移除别名注册与 `tool.alias_warn` 上报（L131），同步删掉 `isDeprecatedToolAlias` / `aliasesFor` 及相关测试，确认 `ria_*` 是唯一对外工具名。
