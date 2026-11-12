# dsh-ria 代码体检（进行中）

## 元信息

- 时间：2026-11-12（Asia/Shanghai）。
- 本轮核对 HEAD：`6a21088`；备份提交：`ecb068b`（保留 superagent 调研，不提交 .tmp-repair）。
- 范围：lib/、test/（19 suite）、README.md、DESIGN.md、docs/task-model-design.md、docs/superagent-borrow.md；不触碰 docs/icon-concepts/ 与 .tmp-repair/ 内容。
- 方法：只读代码/文档审计、子 agent 独立审计、内存 fake 故障复现、回归测试、npm pack --dry-run 检查发布清单。
- 恢复现场：没有未提交受跟踪改动，仅 .tmp-repair/ 未跟踪；npm test 19 suite 全绿。
- 禁止重启 dsh web、同步安装副本、push；另一个 worker 的 workspace attach 修复保留且不纳入本人的提交。

## 文档声称与实际行为

- README.md:224/243 的副作用不丢仅适用于已成功入 durable outbox 的条目，不覆盖派发接受到 note 落盘前崩溃/写失败。
- lib/index.js:2630-2631 声称共享 noteId 防止微信重复，实际 wxweb 每次随机 ClientMsgId；本地卡片 noteId 去重不能代表远端 exactly-once。
- lib/index.js:4 注释仍称 seven tools，实际安装 10 个。
- outbox delivered 幂等仅限现存记录：lib/outbox.mjs:129、193、198-205；24h 清理或超过500提前清理后相同 key 可重新入队。

## 暂不修 / 需要决定

- 微信服务端同 ClientMsgId 去重未核实，不承诺 exactly-once；跨进程/远端事务需专门设计。
- inbound 失败 seen 是现有显式测试策略；改成 durable 重试会改变接受/去重语义，暂需用户拍板。
- delivered 去重窗口是否扩为长期 tombstone、failed 超限丢弃是否允许，涉及存储保留政策。
- atomicWrite fsync 文件未 fsync 目录：lib/outbox.mjs:30-35；进程退出原子写与掉电持久性不同，暂不扩大平台兼容改动。
- 图片路径根限制/符号链接/遍历是否需要授权，需确认产品允许任意本地图片的边界；批量图片总预算、弱 magic、缩进 fence 与 Unicode 分片仍需进一步验证。
- legacy/task→ticket 迁移不能因历史遗留直接删，旧持久状态兼容仍需保留。
- lib/image.mjs 不存在，本次审计实际模块为 lib/wechat/image.mjs。
- .tmp-repair/ 留原处，不提交、不删除；.chrome-v2/ 本轮状态未出现。

## 测试与维护

- 基线、四项已修复后及恢复现场均 npm test：19 suite 全绿。
- 已补 self 错误更正、相对 import 发布清单、partial dispatch 可见确认、不完整 provider catalog 故障注入。
- 后续优先补暂停 deferred、积压队列 await 竞态、媒体重连、分片中途失败；避免只断言 mock 调用而漏查用户可见副作用。

## 已确认问题

行号以发现时版本为准，修复后可能移动。未发现 P0。

### 已修复

|级别|位置|现象与最小复现|修复 / commit|
|---|---|---|---|
|P1|package.json:26-39 / lib/index.js:13|发布 files 缺 lib/turn-end.mjs，npm pack 清单缺直接 import，安装后加载失败|加入发布清单，smoke 检查所有直接相对导入；`531828a`|
|P2|lib/index.js:1939|ria_resolve executor=Ria session id 拒绝却不提示正确写法|提示 executor: "self"；测试失败不变更 intake 并验证更正成功；`c781ecf`|
|P2|lib/index.js:2610-2614 / test/attachments.mjs:62-74|两个目标一成功一失败，已接受的派发无 note/微信镜像|any success 保留确认并附失败目标，只有全成功结束 turn；`ec8a898`|
|P1|lib/index.js:2224-2251|一个 provider 目录失败时，共享 model 看似唯一而猜错路由|无显式 provider 且目录不完整时 fail closed；spawn 不创建、model 不变更；`6a21088`|

### 微信与持久化：待修复 / 边界

1. **P1 暂停耗尽重试** — lib/index.js:2746-2748、2721-2723；lib/wechat/service.mjs:630-637；lib/outbox.mjs:172-181。暂停/离线 sendDispatchNote 返回 false 被视为异常，第 6 次变 failed，约 81 分钟后恢复也不再投递。最小复现：暂停后按 backoff 推进时钟并 pump 六次。建议 deferred 与 failed 分离，恢复主动 pump，补长期暂停恢复故障注入。
2. **P1 微信不具崩溃幂等** — lib/index.js:2719-2720、2747；lib/wechat/wxweb.mjs:229、388；lib/index.js:2630-2631。外部发送成功后才记录 delivered，每次随机 ClientMsgId 且未传 noteId；服务端接收后进程退出或响应丢失，再投产生重复。建议稳定发送 ID + 验证服务端去重语义，否则明确 at-least-once。
3. **P1/P2 flush 与 addOutbox 竞态** — lib/wechat/service.mjs:111-114、701-703。flush 等待 old-0 时追加 41 条使 50 条上限裁掉 old-0，成功后 shift 又删除从未发送的 old-1；内存 fake 已复现。建议按条目身份删除，notice 后清理也按快照身份。
4. **P2 重连绕过媒体路径** — lib/wechat/service.mjs:607、614、652-674、702；lib/wechat/outbound.mjs:30-33。首次失败存原文，重连直接 enqueue 而非 deliverAssistant，图片仅本地路径文本，长 Markdown 截断。建议统一发送路径并记录媒体进度。
5. **P2 图片失败不可恢复** — lib/wechat/service.mjs:193-194、678-685。图片语法已从正文剥离，上传异常只 log，纯图片回复无任何可见结果。内存 fake enqueueImage throw 后正常 resolve。建议独立持久重试项或可见文字 fallback，避免重发成功正文。
6. **P2 分片失败重复前片** — lib/wechat/outbound.mjs:140-147；lib/wechat/service.mjs:614、702。第二片失败后存全文，全量重试重复第一片；fake 序列 A,B(fail),A,B。建议片段进度/稳定 ID，补第二片失败及暂停中途分片测试。
7. **P2 inbound 永久 seen 失败消息** — lib/wechat/service.mjs:242-248；test/wechat.mjs:96-107。prompt 失败仍在 finally markSeen，重投不可恢复；现有测试明确固定该策略。建议成功接受才 seen + 持久 inbound retry，但需先明确去重与失败策略。
8. **P2 派发接受与 outbox 落盘窗口** — lib/index.js:2592-2614、2649-2653。先接受 prompt、删除 delivery、转 working，最后入 note outbox；写失败被吞为 undefined 且跳过微信仍 concludeTurn。建议持久派发意图/副作用协调及失败可见性；跨存储原子性需谨慎设计。
