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

## 微信图片

微信里的图片可以双向收发，默认都开启。你在微信发一张图，Ria 会下载原图、校验后保存到 `DSH_HOME/state/ria/wechat-inbound/`，再以“原文字 + 图片”的普通用户消息接收；纯图片会补一句“（用户发来一张图片）”。之后你让她把这张图转给 worker 时，可以直接用保存路径作为附件。

- 只接受 PNG、JPEG、GIF、WebP，单张上限 20 MB（且不超过宿主附件限制）；目录保留最近 30 天、最多 500 个文件。
- 下载或校验失败不会丢消息：Ria 仍会收到原文字，并多一行 `[图片接收失败：<原因>]`。
- 反向也成立：Ria 回复里的 Markdown 图片若指向本机文件，会作为微信图片发给你。

配置项是 `wechatImage.inbound` 和 `wechatImage.outbound`，都可以在 profile 的 `cordis.yml` 里单独关闭。协议、落盘和清理细节见 [docs/wechat.md](docs/wechat.md#图片)。

## 设置

DSH 设置页里的 Ria 区块使用独立的白底卡片，不跟随主题背景图，深色文字在白底上保持可读。目前有两个开关：

- **任务转交提示**（`dispatchGuard`，默认开）：给所有会话加一段 system prompt，消息明显对不上时先向用户确认。
- **自动暂停微信推送**（`wechatAutoPause`，默认开）：非微信通道发来消息时自动暂停微信推送。暂停时会往微信发一条说明（只发这一条，不会放行其他推送），回一条微信消息即恢复；手动暂停/恢复不受影响。关闭后非微信消息不再自动暂停，当前已暂停的状态保持不变。

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
