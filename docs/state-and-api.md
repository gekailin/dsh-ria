# 状态文件与 HTTP API

## 状态文件

~~~text
DSH_HOME/state/ria/
  ria.json       # riaSessionId、riaPreset、tickets、pending deliveries、grants、settings、dispatchNotes
  outbox.json    # 副作用待投递/失败记录（dispatch note、微信镜像），0600
  memory.md       # 用户偏好和长期记忆
  audit.jsonl     # 临时权限审计，0600
  wechat/creds.json        # 微信文件传输助手登录凭据，0600
  wechat/state.json        # 已处理消息 id、Outbound 队列、暂停状态与时间
  wechat-claw/creds.json   # 微信 Claw bot_token、accountId、baseUrl、userId，0600
  wechat-claw/state.json   # 暂停状态
  wechat-claw/cursor.json  # getupdates 长轮询游标
  qq-bot/creds.json        # QQ 机器人 appId、appSecret、userOpenid，0600
  qq-bot/state.json        # 暂停状态
~~~

不保存聊天 transcript。Ria 的原始 Session 日志仍由 DSH 写在 DSH_HOME/sessions 下。

## HTTP API

前缀：/plugins/dsh-ria/api

- POST /ensure：创建或打开全局唯一的 Ria。
- GET /state：riaSessionId、tickets、pendingDeliveries、grants、settings、workerIdleNotifications（enabled/throttleMs）。
- GET/POST /settings：读取或设置 {dispatchGuard:boolean, wechatAutoPause:boolean}（GET 还返回 progressCards）；POST 可只传其中一个，传了非布尔值或一个都没传返回 400。
- GET /dispatch-notes?sessionId&turn：读取 Ria 的派发 note；sessionId 必须是当前 Ria，turn 可选且必须是非负整数；返回 {notes}。
- GET /board?limit=60&before=<createdAt>：只读任务看板数据。limit 默认 60、范围 1–200，before 是上一页最旧一张的 createdAt；服务端合并热存与归档日志后按 createdAt 升序取最后 limit 张。返回 {ok, generatedAt, riaSessionId, counts:{total,active,terminal,blocked}, page:{limit,before,returned,total,hasMore,nextBefore}, lanes, tickets}；tickets 含 ticketId/goal/status/waitingOn/blockedReason/attention/dependsOn/dependentCount/checklist/progress/executor/executorTitle/executorCwd/executorArchived/executorMissing/archived/laneId/laneLabel/createdAt/updatedAt/closedAt/readyAt/queueState/queueText。executor 为 `self` 或当前 Ria 时归入「Ria · 管家」；worker session 缺失或已归档只降级标道，不返回错误；归档工单带 archived=true。limit 非法或 before 不是时间戳时返回 400。
- GET /health：健康检查。
- GET /wechat/status：微信登录和连接状态，含 paused/pausedBy/pauseReason/pausedAt/resumedAt/resumedBy、wechatAutoPause、folded 和 lastFoldedAt。
- POST /wechat/login：获取登录二维码。
- POST /wechat/logout：退出微信登录。
- POST /wechat/start：用已有凭据重连。
- POST /wechat/pause：手动暂停或恢复推送，body {paused, reason?}。
- GET /channels/status：三个聊天通道（wechat、wechat-claw、qq-bot）的登录和连接状态；每项含 paused/pausedBy/pauseReason/pausedAt/resumedAt/resumedBy，wechat 项另有 wechatAutoPause。
- GET /channels/<id>/status：单个通道状态，id 为 wechat、wechat-claw 或 qq-bot。
- POST /channels/<id>/login：获取二维码并开始扫码登录。
- POST /channels/<id>/logout：退出该通道并删除本机凭据。
- POST /channels/<id>/start：用已有凭据重连。
- POST /channels/<id>/pause：手动暂停或恢复推送，body {paused, reason?}。
- /wechat/status|login|logout|start|pause 仍然保留，等价于 wechat 通道。

所有请求校验 DSH 同源；没有额外的 loopback 端口。
