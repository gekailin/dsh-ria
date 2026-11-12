# dsh-ria

![阿汐站在玻璃中庭里，手里提着一盏灯](docs/hero.jpg)

**阿汐 · Ria** —— 潮起潮落，事事有着落。

Ria 是 DSH Web 的一个常驻管理者插件，全局只有一个阿汐。她不自己写代码：把你说的事整理成 ticket，派给你已有的 worker，或者按需新建一个，然后盯到 done 或 blocked 再回来汇报。worker 那边不用装任何东西，收到的就是一条普通消息。

更多细节见 [DESIGN.md](DESIGN.md) 与 [docs/](docs/)。

## 典型场景

- 让阿汐帮我把这个 bug 修了，修完盯到测试全绿。
- 建一个新的 worker，专门处理某个仓库的文档。
- 把这张设计稿发给 worker，让它照着改界面。
- 出差路上在微信里让阿汐给某个 worker 加个需求，回来收结果。
- 让阿汐给 worker 换个模型再继续；或让一个 worker 全仓体检后出报告。
- 长任务跑到一半被打断时，阿汐会停下来问我要下一步。

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

MIT，见 [LICENSE](LICENSE)。
