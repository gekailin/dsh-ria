# dsh-ria

![阿汐站在玻璃中庭里，手里提着一盏灯](docs/hero.jpg)

**阿汐 · Ria** —— 潮来汐去，万事有绪。

Ria 是 DSH Web 的一个常驻管理者插件，全局只有一个阿汐。她不自己写代码：把你说的事整理成 ticket，派给你已有的 worker，或者按需新建一个，然后盯到 done 或 blocked 再回来汇报。worker 那边不用装任何东西，收到的就是一条普通消息。

更多细节见 [DESIGN.md](DESIGN.md) 与 [docs/](docs/)。

## 典型场景

- 让阿汐帮我把这个 bug 修了，修完盯到测试全绿。
- 建一个新的 worker，专门处理某个仓库的文档。
- 把这张设计稿发给 worker，让它照着改界面。
- 出差路上在微信里让阿汐给某个 worker 加个需求，回来收结果。
- 让阿汐给 worker 换个模型再继续；或让一个 worker 全仓体检后出报告。
- 长任务跑到一半被打断时，阿汐会停下来问我要下一步。
- 说“先做 A，做完再做 B”，阿汐会用 ticket 依赖把 B 排在 A 后面，A 完成后再叫醒她派发 B。

## 任务排队

“先做 A，再做 B”这类要求不需要 Ria 一直等：B 记为 `open` 并带 `dependsOn: [A]`，A 全部完成后 Host 写入就绪时间、生成一次性的 `queueToken`，再叫醒 Ria 派发；同一次就绪不会被重复派发。上游失败或取消时 B 不会自动跳过，而是发 `[Queue blocked]` 让 Ria 来问你。已就绪但还没派发的票会在重启后补一次唤醒。

给忙碌 worker（正在跑 turn 或已有排队消息）追加任务会被拒绝（`worker_busy`）：先后顺序用 `dependsOn` 表达，`steer` 只用于插播信息，不能下发新任务。细节见 [docs/tools.md](docs/tools.md#ticket-排队与依赖)。

## 任务看板

侧栏 Ria 入口右侧有一个「▦ 看板」图标按钮（在设置和「连接」之间），点开是全屏只读看板：横轴是按创建时间等分位排出的 6 段伪时间轴，纵轴按 worker 所在项目（workspace/cwd）分道，没有归属的票进「未分配」。卡片显示短 id、worker、状态色、任务目标、排队原因与依赖数；已完成/已取消的票折叠成两行，避免历史把活跃任务挤出屏幕。依赖用一层 SVG 箭头从上游指向下游，悬停卡片只高亮相关边；顶部可按全部/活跃/仅阻塞筛选，点状态图例可高亮该状态。

数据来自只读端点 `GET /plugins/dsh-ria/api/board`，页面本身不写状态、不触发派发。示例见 [docs/assets/ria-board-preview.png](docs/assets/ria-board-preview.png)（真实 84 票，1440×1160）。

## 聊天连接

侧边栏 Ria 标题右侧的“连接”chip 里有三个通道，都可以扫码登录、查看状态和暂停推送：

- 微信「文件传输助手」网页版：文本、图片、.md 文件双向；见 [docs/wechat.md](docs/wechat.md)。
- 微信 Claw：直接对接腾讯 iLink 机器人接口，扫码后由 `bot_token` 收发文本；也能接收派发 note、审批提醒和自动暂停提示（纯文本）。
- QQ 机器人：用 QQ 开放平台的扫码绑定拿 AppID/AppSecret，再通过官方 SDK 的 WebSocket 网关收发文本。

后两个通道只处理文本，不依赖 OpenClaw，也不启动额外进程。扫码、协议、状态文件、HTTP API 和多通道暂停规则见 [docs/channels.md](docs/channels.md)。

## 微信图片

微信里的图片可以双向收发，默认都开启。你在微信发一张图，Ria 会下载原图、校验后保存到 `DSH_HOME/state/ria/wechat-inbound/`，再以“原文字 + 图片”的普通用户消息接收；纯图片会补一句“（用户发来一张图片）”。之后你让她把这张图转给 worker 时，可以直接用保存路径作为附件。

- 只接受 PNG、JPEG、GIF、WebP，单张上限 20 MB（且不超过宿主附件限制）；目录保留最近 30 天、最多 500 个文件。
- 下载或校验失败不会丢消息：Ria 仍会收到原文字，并多一行 `[图片接收失败：<原因>]`。
- 反向也成立：Ria 回复里的 Markdown 图片若指向本机文件，会作为微信图片发给你。

配置项是 `wechatImage.inbound` 和 `wechatImage.outbound`，都可以在 profile 的 `cordis.yml` 里单独关闭。协议、落盘和清理细节见 [docs/wechat.md](docs/wechat.md#图片)。

## 设置

DSH 设置页里的 Ria 区块使用独立的白底卡片，不跟随主题背景图，深色文字在白底上保持可读。目前有两个开关：

- **任务转交提示**（`dispatchGuard`，默认开）：给所有会话加一段 system prompt，消息明显对不上时先向用户确认。
- **自动暂停微信推送**（`wechatAutoPause`，默认开）：微信「文件传输助手」之外的通道（含微信 Claw、QQ）发来消息时，自动暂停「文件传输助手」推送。暂停时会往当前活跃的微信侧通道发一条说明（只发这一条，不会放行其他推送），回一条「文件传输助手」消息即恢复；手动暂停/恢复不受影响。关闭后只关闭「文件传输助手」的自动暂停，Claw/QQ 仍按“最后消息通道”规则切换。派发 note、审批提醒也发给最近活跃的微信侧通道，两个都不可用时留在 outbox 重试。

## 工具

Ria 通过 run_code SDK 调用 12 个 `ria_*` 工具：`ria_resolve`、`ria_ticket`、`ria_status`、`ria_spawn`、`ria_model`、`ria_title`、`ria_request`、`ria_read`、`ria_queue`、`ria_memory`、`ria_approval`、`ria_grant`。其中 `ria_title` 只改会话名，不发消息、不建 ticket、不唤醒 worker，也不改其它状态；完整参数和失败码见 [docs/tools.md](docs/tools.md)。

## 安装

在仓库目录执行：

~~~bash
dsh plugin --profile web add file:$PWD
~~~

然后重启 dsh web 生效。

如果 pnpm 全局 store 不可写，可以进入 profile 目录手动安装：

~~~bash
cd ~/.dsh/profiles/web
pnpm add --ignore-scripts file:/绝对路径/dsh-ria
~~~

## License

Apache License 2.0，见 [LICENSE](LICENSE)。
