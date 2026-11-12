# 状态文件与 HTTP API

## 状态文件

~~~text
DSH_HOME/state/ria/
  ria.json       # riaSessionId、riaPreset、tickets、pending deliveries、grants、settings、dispatchNotes
  outbox.json    # 副作用待投递/失败记录（dispatch note、微信镜像），0600
  memory.md       # 用户偏好和长期记忆
  audit.jsonl     # 临时权限审计，0600
  wechat/creds.json  # 微信登录凭据，0600
  wechat/state.json  # 已处理消息 id、Outbound 队列、暂停状态与时间
~~~

不保存聊天 transcript。Ria 的原始 Session 日志仍由 DSH 写在 DSH_HOME/sessions 下。

## HTTP API

前缀：/plugins/dsh-ria/api

- POST /ensure：创建或打开全局唯一的 Ria。
- GET /state：riaSessionId、tickets、pendingDeliveries、grants、settings、workerIdleNotifications（enabled/throttleMs）。
- GET/POST /settings：读取或设置 {dispatchGuard:boolean, wechatAutoPause:boolean}（GET 还返回 progressCards）；POST 可只传其中一个，传了非布尔值或一个都没传返回 400。
- GET /dispatch-notes?sessionId&turn：读取 Ria 的派发 note；sessionId 必须是当前 Ria，turn 可选且必须是非负整数；返回 {notes}。
- GET /health：健康检查。
- GET /wechat/status：微信登录和连接状态，含 paused/pausedBy/pauseReason/pausedAt/resumedAt/resumedBy 和 wechatAutoPause。
- POST /wechat/login：获取登录二维码。
- POST /wechat/logout：退出微信登录。
- POST /wechat/start：用已有凭据重连。
- POST /wechat/pause：手动暂停或恢复推送，body {paused, reason?}。

所有请求校验 DSH 同源；没有额外的 loopback 端口。
