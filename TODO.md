# TODO

## 一次性迁移清理（v2 → state）

- `lib/state/naming-migration.mjs` 是一次性迁移代码，不是长期功能。
- 删除触发条件：`state.json` 已稳定运行一版，且线上确认不再需要从 `v2.json` 回滚。
- 删除时同步移除启动调用（RiaService 构造函数）、迁移单测和旧键兼容读。
- `v2.json.bak-*` 清理时机：上述删除条件满足、且连续一版启动未再产生新备份后，人工确认无回滚需要再删除；不要按固定日期清理。
- 迁移备份目录 `naming-migration-*` 与 `v2.json.bak-*` 同批清理，清理前保留一次完整备份。
