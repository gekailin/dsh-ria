# Cognition settings and voice

- 说话风格（voice）属于 `settings.style`，单一来源；Chat prompt 的 `[说话风格]` 只由它驱动，最多 500 字。
- `settings.cognition` 只承载认知设置；当前没有字段时该对象整体不出现。
- 兼容迁移：旧 state 中的 `settings.cognition.voice` 在加载时一次性搬到 `settings.style`（仅当 style 为空），随后删除旧键，并记录一次 `settings.voice.migrated`；重复执行幂等。style 已有值时只删除旧键，不覆盖。
