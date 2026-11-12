# 已知限制与安全边界

## 限制

- 微信协议依赖「文件传输助手」网页版；入站只投递文本（入站图片仍预留），出站可发文本、.md 文件与本机图片；出站图片只按网页版协议用 mock 验证过，尚未用真实微信账号完成一次图片收发验证。
- 暂停推送的界面入口只在 chip 弹层里；设置页“Ria”不重复放同一个开关，避免两个控制点。
- 暂停不能撤回已经在发送中的消息；只能保证之后排队的消息不发出。
- 暂停期间的连接保持和真实收发没有用真实微信账号验证，只做了单元测试和 HTTP smoke。
- 微信文件上传/发送链路按网页版协议实现并用 mock 覆盖，尚未用真实微信账号完成一次 .md 文件收发验证。
- 出站图片只在 assistant 文本里提取本机图片，不支持直接把 DSH 的 imagePart 或远程 URL 转成微信图片；入站图片仍未实现。
- 扫码登录、消息收发和派发 note 的微信镜像仍需要真实微信账号验证。
- 审批可见性只报告 pending，不代批、不自动唤醒 Ria；临时权限需要用户明确指令，Ria 不能自行判断后提权。
- worker 自动唤醒由 `agent/status` 的 `idle` 触发，能读到最后一轮 `turn/end` 的 reason（含 `aborted(user)`），但“明确拒绝”只能由 Ria 读消息判断；提示措辞不假设完成，需要 Ria 再 read。
- 不做 needs_input/failed 的独立事件级唤醒；需要时用官方 schedule 或用户回来问。
- worker-idle 通知没有在真实 worker 会话里触发过，只用 mock 事件验证。
- 不做多实例防双开。
- 澄清门禁是 prompt 行为，不是 Host 强制状态机。
- Ria 依赖 PTC preset；standard 模式不会作为后备。
- 额外创建一个 Ria Workspace 是当前 DSH UI 的硬要求。
- 欢迎卡片由 client 插件渲染（`conversation.input.dock`），不写 session 日志、不占 turn。Host 侧曾用合成的 assistant turn 显示欢迎气泡；该 turn 排在真实 turn 的 system/message 之前，v4 校验报 `system/message requires a protected first surface head`，重启加载历史 corrupt，因此废弃。
- 防误发提示是 agent system prompt 的行为约束，不是硬拦截；worker 仍可能直接执行明显无关的消息。设置页只开关该 section，不能保证模型遵守。
- note 卡片已在隔离 DSH 的真实 Web UI 中验证渲染：`[data-ria-dispatch-note="ticket"]` 出现在轮次末尾，标题“任务已派发”。该截图用手工写入 ria.json 的 note 验证 UI；真实 `ria_request` 写入路径由 smoke 覆盖。截图：`docs/ui-dispatch-note.png`。
- note 只保留最近 100 条；更早的卡片不会再显示。
- note 缺失/空白/超长是 Host 硬报错；note 展示失败只记 warn，不阻断已经成功的派发。
- 临时权限只在单元测试和 smoke 中验证过，还没有在真实 worker 会话里触发；首次使用时需要确认 DSH 的 sandbox/approval 事件投影和恢复行为。
- “近期 worker”只记录 Ria 成功派发过的会话；用户手工在其他会话里做的使用不会计入。挑选本身是 prompt 行为约束，不是 Host 强制，模型仍可能违背；尚未用真实模型验证。
- DSH 的 sandbox override 无法清除；恢复会写回原 effective mode，因此可能留下一个同值 override。

## 安全

- memory.md 和微信 creds/state 权限 0600；memory.md 禁止写凭据/token。
- 微信凭据只在本地 stateDir；没有额外的 loopback API，UI API 校验 DSH 同源。
- 不自动上传、不遥测。
- Ria 可以读 Session、发消息、建任务；这些能力只在用户明确要求时使用。
- `approval/request` 监听器只读：记录 pending 后调用 next()，从不返回审批结果。
- `agent/status` 监听器只读 worker 的 id 和状态，只向 Ria 发通知；不 resume、不写 worker。
- 临时权限只写当前 session 的 sandbox/mode 和 approval policy 投影，不改全局默认，也不改 worker 的 tools/prompt/preset；所有变更写入 audit.jsonl 0600。
- 删除 Ria 不会自动删除 ticket、memory 和 Workspace；需要时手动清理。
