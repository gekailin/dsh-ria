# dsh-ria 代码体检

本轮完成：确认16项行为问题，已修12项，保留4项需要专门设计/策略决定；另修复文档漂移。未发现P0，不作大架构改造。

## 元信息

- 时间：2026-11-12（Asia/Shanghai）。
- 最终验证：npm test 21 suite 全绿，exit 0；git diff --check 通过。无重启/同步/push；工作树最终仅保留未跟踪 .tmp-repair/。
- 无公开工具删除、持久schema版本变更或其他破坏性API变更；故意收紧不完整模型目录的隐式路由，保留显式provider路径。错误v2 attempt不再被隐式标legacy，可能使损坏历史记录暴露校验错误。
- 初次核对 HEAD：`6a21088`；最终代码 HEAD：`2d960aa`（最终报告提交在其后）；备份提交：`ecb068b`（保留 superagent 调研，不提交 .tmp-repair）。
- 范围：lib/、test/（19 suite）、README.md、DESIGN.md、docs/task-model-design.md、docs/superagent-borrow.md；不触碰 docs/icon-concepts/ 与 .tmp-repair/ 内容。
- 方法：只读代码/文档审计、子 agent 独立审计、内存 fake 故障复现、回归测试、npm pack --dry-run 检查发布清单。
- 恢复现场：没有未提交受跟踪改动，仅 .tmp-repair/ 未跟踪；npm test 19 suite 全绿。
- 禁止重启 dsh web、同步安装副本、push；另一个 worker 的 workspace attach 修复保留且不纳入本人的提交。

## 文档声称与实际行为

- README.md:224/243 的副作用不丢仅适用于已成功入 durable outbox 的条目，不覆盖派发接受到 note 落盘前崩溃/写失败。
- lib/index.js:2630-2631 声称共享 noteId 防止微信重复，实际 wxweb 每次随机 ClientMsgId；本地卡片 noteId 去重不能代表远端 exactly-once。
- 已修 `a2c2a58`：工具数10、ticket_executor_mismatch描述、split P1、quick relay 历史边界、图片已实现、历史方案版本提示；README/DESIGN 与源码不再承诺微信崩溃 exactly-once。
- outbox delivered 幂等仅限现存记录：lib/outbox.mjs:129、193、198-205；24h 清理或超过500提前清理后相同 key 可重新入队。

## 暂不修 / 需要决定

- 微信服务端同 ClientMsgId 去重未核实，不承诺 exactly-once；跨进程/远端事务需专门设计。
- inbound 失败 seen 是现有显式测试策略；改成 durable 重试会改变接受/去重语义，暂需用户拍板。
- delivered 去重窗口是否扩为长期 tombstone、failed 超限丢弃是否允许，涉及存储保留政策。
- atomicWrite fsync 文件未 fsync 目录：lib/outbox.mjs:30-35；进程退出原子写与掉电持久性不同，暂不扩大平台兼容改动。
- 图片路径根限制/符号链接/遍历是否需要授权，需确认产品允许任意本地图片的边界；批量图片总预算、弱 magic、缩进 fence 仍需进一步验证。Unicode分片已确认并修复，见下文。
- legacy/task→ticket 迁移不能因历史遗留直接删，旧持久状态兼容仍需保留。
- lib/image.mjs 不存在，本次审计实际模块为 lib/wechat/image.mjs。
- .tmp-repair/ 留原处，不提交、不删除；.chrome-v2/ 本轮状态未出现。

## 测试与维护

- 基线、四项已修复后及恢复现场均 npm test：19 suite 全绿。
- 已补 self 错误更正、相对 import 发布清单、partial dispatch 可见确认、不完整 provider catalog 故障注入。
- 已补暂停/离线 deferred 与真实失败、积压队列两个 await 竞态、取消节流、v2 legacy重载、空白attention重载。最近 npm test 21 suite 全绿（exit 0）。已补真实Outbound图片/文件故障、fallback双失败与跨重启恢复测试，全部使用明确completion gate；分片进度及远端事务仍未修。
- 维护建议：用明确completion gates替换固定20ms/10ms等待；审批TTL注入可控时钟；补注册schema契约与图片/文本/文件跨类型串行测试。不要把共享fixture断言等同真实宿主图像解码测试。

## 新增文本分片问题

- **P2 Unicode分片破坏 emoji（已修 `5a628d3`）**：lib/wechat/outbound.mjs:23-27 按UTF-16长度slice，1800边界可拆开surrogate pair。最小复现：1799个a后接🌊与长文本；修复切点避开代理对，测试max=1/2/1800全部片段isWellFormed且拼接还原原文。不改变长文本最多4片的原有限制。

## 新增状态机审计结论

- **P1 用户取消被节流吞掉（已修 `e5292c4`）**：lib/worker-idle.mjs:137-153 在读取 turn/end 前节流；同 ticket completed 后30秒内 user-abort 不进入 blocked。现在取消先处理且绕过普通通知节流；测试验证等待用户、无继续派发、重复事件不重复通知。
- **P2 显式 legacy:false 被覆盖（已修 `54d9a8d`）**：lib/tickets.mjs:153-154、lib/index.js:252-253；v2 working 无 lastRequestId 重载时被改 legacy:true，绕过 attempt_required。保留显式 false，仅缺 attempt 的旧记录补 legacy；补真实 store.save/load。
- **P2 空白 blockedReason 不兼容 attention（已修 `2f7cd32`）**：lib/tickets.mjs:168-169；空格 reason 与合法 question 加载后 invariant 拒绝。改 trim 判空并回填 question；补创建和真实存储重载。
- matched legacy recoveryCount>=3 迁移与 unmatched 不一致，但 lib/index.js:3133-3140 的 startup 已有 blockForRecovery 兜底，不计确认故障，不删旧迁移。
- 协作修复已由另一 worker 提交 `227572e`、`cfb8e12`：新建 worker 归属 workspace 与启动孤儿对账。安装副本未同步、服务未重启，live 仍旧行为；当前 npm test 已扩到21 suite 且全绿。

## 已确认问题

行号以发现时版本为准，修复后可能移动。未发现 P0。

### 已修复

|级别|位置|现象与最小复现|修复 / commit|
|---|---|---|---|
|P1|package.json:26-39 / lib/index.js:13|发布 files 缺 lib/turn-end.mjs，npm pack 清单缺直接 import，安装后加载失败|加入发布清单，smoke 检查所有直接相对导入；`531828a`|
|P2|lib/index.js:1939|ria_resolve executor=Ria session id 拒绝却不提示正确写法|提示 executor: "self"；测试失败不变更 intake 并验证更正成功；`c781ecf`|
|P2|lib/index.js:2610-2614 / test/attachments.mjs:62-74|两个目标一成功一失败，已接受的派发无 note/微信镜像|any success 保留确认并附失败目标，只有全成功结束 turn；`ec8a898`|
|P1|lib/index.js:2224-2251|一个 provider 目录失败时，共享 model 看似唯一而猜错路由|无显式 provider 且目录不完整时 fail closed；spawn 不创建、model 不变更；`6a21088`|

### 微信与持久化：修复结果 / 未修边界

1. **P1 暂停耗尽重试** — lib/index.js:2746-2748、2721-2723；lib/wechat/service.mjs:630-637；lib/outbox.mjs:172-181。暂停/离线 sendDispatchNote 返回 false 被视为异常，第 6 次变 failed，约 81 分钟后恢复也不再投递。最小复现：暂停后按 backoff 推进时钟并 pump 六次。已修 `6bb956e`：durable 暂停/离线 deferred 不计 attempts，真实网络错误计失败；十次暂停 pump、离线及恢复投递故障注入通过。恢复依赖已有30秒tick。
2. **P1 微信不具崩溃幂等** — lib/index.js:2719-2720、2747；lib/wechat/wxweb.mjs:229、388；lib/index.js:2630-2631。外部发送成功后才记录 delivered，每次随机 ClientMsgId 且未传 noteId；服务端接收后进程退出或响应丢失，再投产生重复。建议稳定发送 ID + 验证服务端去重语义，否则明确 at-least-once。
3. **P1/P2 flush 与 addOutbox 竞态** — lib/wechat/service.mjs:111-114、701-703。flush 等待 old-0 时追加 41 条使 50 条上限裁掉 old-0，成功后 shift 又删除从未发送的 old-1；内存 fake 已复现。已修 `8a0e308`：按原对象身份删除，notice 后按快照身份删除；两个 await gate 实测追加/上限裁剪竞态。
4. **P2 重连绕过媒体路径** — lib/wechat/service.mjs:607、614、652-674、702；lib/wechat/outbound.mjs:30-33。首次失败存原文，重连直接 enqueue 而非 deliverAssistant，图片仅本地路径文本，长 Markdown 截断。已修 `58e8b9e`：flush 统一走 deliverAssistant，真实图片与8000字符Markdown文件发送使用completion gate，发送完成前不删积压且完成后持久清空。跨片段进度仍属下述未修项。
5. **P2 图片失败不可恢复** — lib/wechat/service.mjs:193-194、678-685。图片语法已从正文剥离，上传异常只 log，纯图片回复无任何可见结果。内存 fake enqueueImage throw 后正常 resolve。已修 `2d960aa`：上传失败发明确文字fallback；fallback成功作为可见降级交付，原图不再自动重试；fallback也失败则原文仍持久保留，跨重启下一次图片成功后清理。仍可能重复先前已成功正文，属于分片/媒体进度未修边界。
6. **P2 分片失败重复前片** — lib/wechat/outbound.mjs:140-147；lib/wechat/service.mjs:614、702。第二片失败后存全文，全量重试重复第一片；fake 序列 A,B(fail),A,B。建议片段进度/稳定 ID，补第二片失败及暂停中途分片测试。
7. **P2 inbound 永久 seen 失败消息** — lib/wechat/service.mjs:242-248；test/wechat.mjs:96-107。prompt 失败仍在 finally markSeen，重投不可恢复；现有测试明确固定该策略。建议成功接受才 seen + 持久 inbound retry，但需先明确去重与失败策略。
8. **P2 派发接受与 outbox 落盘窗口** — lib/index.js:2592-2614、2649-2653。先接受 prompt、删除 delivery、转 working，最后入 note outbox；写失败被吞为 undefined 且跳过微信仍 concludeTurn。建议持久派发意图/副作用协调及失败可见性；跨存储原子性需谨慎设计。
