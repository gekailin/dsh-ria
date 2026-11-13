# 有事，找阿汐
**Just ask for Ria.**

![阿汐站在玻璃中庭里，手里提着一盏灯](docs/hero.jpg)

阿汐（Ria）是 DSH Web 插件 dsh-ria 里的常驻管家：您把事说清楚，她拆成一张张带验收标准的活儿，派给合适的 worker，盯到收尾，再把结果和卡点带回来。她不替 worker 写代码，也不要求您记命令——您只管对她说人话。

## 经典用法

- **「阿汐，让老周把登录页的验证码换成滑块，今天上线。」**
  <sub>她拆好验收条件和步骤，派给老周，盯到联调和测试都过，再回来告诉你。</sub>
- **「阿汐，我们聊聊账单页要不要拆成两个 tab，先别动代码。」**
  <sub>她先和你把取舍、边界和风险过一遍，等你说“就按这个来”，再落成能派的活。</sub>
- **「阿汐，等支付回调联调完，再让小林接后台导出。」**
  <sub>她记住先后顺序，前一件没收尾就不催后一件；轮到小林时把上下文一并交过去。</sub>
- **「阿汐，盯一下数据看板那个活，卡住就告诉我卡在哪。」**
  <sub>她盯着进展，遇到卡点带着原因来问你，而不是等到最后才说“做不完”。</sub>
- **「阿汐，搜索结果页不对，筛选条件没带上，让改的人再返工一版。」**
  <sub>她把问题写成可验收的标准，退回给原来的 worker，改完按同一标准复核。</sub>
- **「阿汐，给写文档的 worker 开一下这个仓库的写权限，只开 docs/。」**
  <sub>她按最小范围调整权限，改完把生效范围和回滚方式一起告诉你。</sub>

## 安装

~~~bash
dsh plugin --profile web add github:gekailin/dsh-ria
~~~

重启 dsh web 生效。

若 `dsh plugin` 报 pnpm store 不可写，进入 `~/.dsh/profiles/web` 执行 `pnpm add --ignore-scripts github:gekailin/dsh-ria`；github: 简写解析不稳时改用 `git+https://github.com/gekailin/dsh-ria.git`。本地改代码调试才用 `file:` 路径：`dsh plugin --profile web add file:$PWD`。

## License

Apache License 2.0，见 [LICENSE](LICENSE)。
