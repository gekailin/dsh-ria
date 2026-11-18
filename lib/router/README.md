# Router（独立模块）

这是 Router 的生产实现入口，和 experiments/router 的实验脚本同源，但不接入选票/派发流程。它只做一件事：给定候选和请求，让模型打分，再用确定性规则给出路由决定。

## 不变量

- 模型只输出候选分数、confidence、reason、no_fit、needs_clarification。
- 路由决定由 lib/router/decide.mjs 的规则做出，模型不直接选 session，也不改 ticket 状态。
- 不创建 session、不写 ticket、不写知识、不碰 Ria 的现有状态。
- 默认候选是占位数据；真实 registry 接上后替换 candidates 即可。

## 用 DSH 的 LLM（无 session）

routeWithLlm 通过 ctx.llm.stream() 直接发一次模型请求，不需要 Agent / Session，也不会写 session log。适合 Router 打分。

~~~js
import { routeWithLlm } from './lib/router/index.mjs'

const result = await routeWithLlm({
  llm,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  mode: 'project',
  request: '把 Ria 看板按项目分组',
})
~~~

## HTTP 预览（真机测试）

插件启动后暴露一个只读、无副作用的预览端点：

~~~
POST /plugins/dsh-ria/api/router/score
Content-Type: application/json

{
  "mode": "project",
  "request": "把 Ria 看板按项目分组",
  "provider": "deepseek-official",
  "model": "deepseek-v4-flash"
}
~~~

candidates 省略时使用默认候选；传了就必须是 {id, kind?, label?, description?} 数组。端点只读，不改 ticket、不建 session。

也可以用环境变量提供默认模型：RIA_ROUTER_PROVIDER、RIA_ROUTER_MODEL。

## CLI（本地模型端点）

~~~bash
node lib/router/cli.mjs --provider auto
node lib/router/cli.mjs --case s1 --provider friday
node lib/router/cli.mjs --mode project --request "..." --provider mccodex
~~~

FRIDAY_API_KEY 只从环境读取，不写进仓库。

## 测试

~~~bash
node test/router.mjs
~~~
