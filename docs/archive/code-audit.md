# dsh-ria 代码体检归档（2026-11-12）

> 状态：历史审计（2026-11-12）；16 项确认问题、12 项已修、4 项保留为设计/策略待定。这是历史快照，不是现行清单。
> 现行文档见 `docs/limitations.md`、`docs/operations.md`、`docs/testing.md` 与 `README.md`。

## 背景与目标

- 范围：`lib/`、`test/`（19 suite）、README.md、历史设计稿 `design-history.md`、`task-model.md`、`superagent-borrow.md`；不触碰 `docs/icon-concepts/` 与 `.tmp-repair/`。
- 方法：只读代码/文档审计、子 agent 独立审计、内存 fake 故障复现、回归测试、`npm pack --dry-run` 检查发布清单。
- 结论：未发现 P0，不作大架构改造；无公开工具删除、无持久 schema 版本变更。
- 现场：初次核对 HEAD `6a21088`，最终代码 HEAD `2d960aa`，备份提交 `ecb068b`；`npm test` 由 19 suite 扩到 21 suite 全绿（exit 0），`git diff --check` 通过，工作树仅保留未跟踪 `.tmp-repair/`。
- 有意收紧的行为：无显式 provider 且模型目录不完整时 fail closed；错误 v2 attempt 不再被隐式标 legacy，可能使损坏的历史记录暴露校验错误。

## 关键决策（含理由）

- **微信降级为 at-least-once**：外部发送成功后才记 delivered，wxweb 每次随机 `ClientMsgId` 且不传 noteId，服务端同 ID 去重未核实；跨进程/远端事务需专门设计。因此不在文档里承诺崩溃 exactly-once，改述为副作用不丢仅适用于已成功入 durable outbox 的条目（README.md:224/243）。
- **inbound 失败仍 markSeen**：改成 durable 重试会改变接受/去重语义，且 `test/wechat.mjs:96-107` 已显式固定该策略，属需用户拍板的策略项，不动。
- **delivered 去重窗口不扩为长期 tombstone**：`lib/outbox.mjs` 在 24h 或超 500 条时提前清理，清理后相同 key 可重新入队；扩 tombstone、failed 超限丢弃都属存储保留政策。
- **atomicWrite 不补 fsync 目录**：进程退出时的原子写与掉电持久性是两件事，不为后者扩大平台兼容改动。
- **暂停/离线与真实网络错误分开计 attempts**：暂停是预期状态，不该消耗重试预算；否则恢复后不再投递。
- **取消优先于通知节流**：用户取消不能被 30 秒去抖窗口吞掉。
- **provider 目录不完整即 fail closed**：共享 model 名在多个 provider 下重名时，宁可拒绝也不猜路由（不 spawn、不改 model）。

## 关键机制与数字

- 长文本分片：按 UTF-16 长度 slice，1800 字符边界可能拆开 surrogate pair；长文本最多 4 片的原限制未变；测试覆盖 max=1/2/1800，每片 `isWellFormed` 且拼接还原原文。
- 重试预算：durable 暂停/离线不计 attempts、真实网络错误计失败；第 6 次才转 failed，约 81 分钟；恢复依赖已有的 30 秒 tick。
- flush 竞态：队列上限 50 条；flush 等待 old-0 时追加 41 条会把 old-0 裁掉，成功后 shift 又误删从未发送的 old-1。
- outbox 幂等仅限现存记录：`lib/outbox.mjs:129`、`:193`、`:198-205`。
- 取消节流窗口：同一 ticket completed 后 30 秒内的 user-abort 原本进不了 blocked（`lib/worker-idle.mjs:137-153`）。
- legacy v2：v2 working 无 `lastRequestId` 重载时被改成 `legacy:true`，绕过 `attempt_required`（`lib/tickets.mjs:153-154`、`lib/index.js:252-253`）。
- 空白 blockedReason：纯空格 reason 与合法 question 加载后被 invariant 拒绝（`lib/tickets.mjs:168-169`），改为 trim 判空并回填 question。
- 图片/媒体失败路径：上传失败发文字 fallback；fallback 成功即作为可见降级交付、原图不再自动重试；fallback 也失败则原文仍持久保留，跨重启在下一次图片成功后清理。仍可能重复先前已成功的正文，属分片/媒体进度未修边界。

## 实现状态（12 项已修，各一句）

- P1 发布清单缺文件：`package.json` 的 files 漏 `lib/turn-end.mjs`，`npm pack` 后直接 import 失败；补清单并让 smoke 检查所有直接相对导入（`531828a`）。
- P1 provider 目录失败猜错路由：一个 provider 目录出错时共享 model 看似唯一；无显式 provider 且目录不完整即 fail closed（`6a21088`）。
- P1 暂停耗尽重试：暂停/离线时 `sendDispatchNote` 返回 false 被当异常，第 6 次变 failed、恢复后也不再投递；durable 暂停改为 deferred 不计 attempts（`6bb956e`）。
- P1 flush 与 addOutbox 竞态：改为按原对象身份删除、notice 后按快照身份删除（`8a0e308`）。
- P1 用户取消被节流吞：取消先处理并绕过普通通知节流，测试验证不自动续派、重复事件不重复通知（`e5292c4`）。
- P2 Unicode 分片破坏 emoji：切点避开代理对（`5a628d3`）。
- P2 重连绕过媒体路径：flush 统一走 `deliverAssistant`，真实图片与 8000 字符 Markdown 用 completion gate 验证（`58e8b9e`）。
- P2 图片失败不可恢复：补文字 fallback，纯图片回复不再无可见结果（`2d960aa`）。
- P2 显式 `legacy:false` 被覆盖：保留显式 false，仅给缺 attempt 的旧记录补 legacy（`54d9a8d`）。
- P2 空白 blockedReason 不兼容 attention：trim 判空并回填 question（`2f7cd32`）。
- P2 ria_resolve 提示缺失：拒绝 `executor=Ria session id` 时提示 `executor: self`（`c781ecf`）。
- P2 部分成功派发无确认：any success 保留确认并附失败目标，只有全成功才结束 turn（`ec8a898`）。
- 文档漂移（`a2c2a58`）：工具数 10、`ticket_executor_mismatch` 描述、split P1、quick relay 历史边界、图片已实现、历史方案版本提示。

## 仍未实现 / 风险

- **微信不具崩溃 exactly-once（保留）**：`lib/index.js:2719-2720`、`:2747`、`lib/wechat/wxweb.mjs:229`、`:388`、`lib/index.js:2630-2631`。发送成功后才记录 delivered，服务端已接收但进程退出或响应丢失时会重复投递；`lib/index.js:2630-2631` 声称共享 noteId 防微信重复，实际本地卡片 noteId 去重不代表远端 exactly-once。要么稳定发送 ID 并验证服务端去重，要么明确写 at-least-once。
- **inbound 失败永久 seen（保留）**：`lib/wechat/service.mjs:242-248` 在 finally 里 markSeen，prompt 失败的消息重投不可恢复。
- **delivered 去重窗口（保留）**：24h / 500 条清理后同 key 可重新入队；是否扩为长期 tombstone、failed 超限是否允许丢弃，均待定。
- **atomicWrite 未 fsync 目录（保留）**：`lib/outbox.mjs:30-35`，掉电时目录项可能丢失。
- **图片路径边界（保留）**：根限制、符号链接、路径遍历是否需授权，取决于产品是否允许任意本地图片；批量图片总预算、弱 magic、缩进 fence 仍需验证。
- **分片失败重复前片（未修）**：`lib/wechat/outbound.mjs:140-147`，第二片失败后存全文，全量重试重复第一片（fake 序列 A, B(fail), A, B）；需片段进度或稳定 ID，并补第二片失败/暂停中途分片测试。
- **派发接受与 outbox 落盘窗口（未修）**：`lib/index.js:2592-2614`、`:2649-2653`，先接受 prompt、删 delivery、转 working，最后才入 note outbox；写失败被吞成 undefined 且跳过微信仍 concludeTurn。
- **legacy 迁移兼容**：`task→ticket` 迁移不能按历史遗留直接删；matched legacy `recoveryCount>=3` 与 unmatched 不一致，但有 `lib/index.js:3133-3140` 的 startup `blockForRecovery` 兜底，不计故障。
- **维护建议**：用明确 completion gates 替换固定 20ms/10ms 等待；审批 TTL 注入可控时钟；补注册 schema 契约与图片/文本/文件跨类型串行测试；不要把共享 fixture 断言当成真实宿主图像解码测试。

## 现行文档

- 已知限制与边界：`docs/limitations.md`；运维与恢复流程：`docs/operations.md`；测试与维护约定：`docs/testing.md`。
- 对外行为承诺以 README.md 与源码为准；本文件只记录 2026-11-12 的审计快照，行号与 commit 均已过期，引用前需重新核对。
