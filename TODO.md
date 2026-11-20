# TODO

## 一次性迁移与 deprecated 别名清理（v2 → state）

- `lib/state/naming-migration.mjs` 是一次性迁移代码，不是长期功能。
- 删除触发条件：`state.json` 已稳定运行一版，且线上确认不再需要从 `v2.json` 回滚。
- 删除时同步移除启动调用（RiaService 构造函数）、迁移单测和旧键兼容读。
- `v2.json.bak-*` 清理时机：上述删除条件满足、且连续一版启动未再产生新备份后，人工确认无回滚需要再删除；不要按固定日期清理。
- 迁移备份目录 `naming-migration-*` 与 `v2.json.bak-*` 同批清理，清理前保留一次完整备份。
- 同批清理 deprecated 工具名别名（不按日期，按触发条件）：
  - 对象：`lib/tools/registry.mjs` 的 `aliasesFor`（L114-122）与 `isDeprecatedToolAlias`（L27），以及 L125-138 注册的旧名：`chatbot_*`、`chat_*`、`ticket_*`、`sage_*`、`lesson_*`、`session_*`、`worker_report`。
  - 触发条件：`ria_*` 新名已在线上稳定运行一段时间，且 `operation-events.jsonl` 中 `tool.alias_warn` 不再出现旧名调用（无新增 alias 记录）。
  - 清理内容：移除别名注册与 `tool.alias_warn` 上报（L131），同步删掉 `isDeprecatedToolAlias` / `aliasesFor` 及相关测试，确认 `ria_*` 是唯一对外工具名。
