export const ROUTER_MODES = ['project', 'session']

// Default candidates are deliberately plain data. The production registry will
// replace them later; keeping them here lets the same scorer run in tests, in
// the CLI, and through the opt-in HTTP preview without touching ticket state.
export const candidates = {
  project: [
    {
      id: 'project:dsh-ria',
      kind: 'project',
      label: 'dsh-ria',
      description: 'DSH 的 Ria 编排插件：Request/ticket、Router、Think、看板、审批、SQLite 存储与会话管理。',
    },
    {
      id: 'project:web-ui',
      kind: 'project',
      label: 'web-ui',
      description: 'DSH Web 前端：布局、组件、样式、可访问性、窄屏适配和交互细节。',
    },
    {
      id: 'project:infra',
      kind: 'project',
      label: 'infra',
      description: '本地服务、代理端口、部署、Node 版本、SQLite/存储运维和启动脚本。',
    },
    {
      id: 'global',
      kind: 'global',
      label: 'global',
      description: '跨项目、战略取舍、通用规范，或无法归入单一项目的工作。',
    },
    {
      id: 'ask',
      kind: 'action',
      label: 'ask',
      description: '信息不足或候选冲突，先询问用户，不强行路由。',
    },
  ],
  session: [
    {
      id: 'session:impl',
      kind: 'session',
      label: 'impl',
      description: 'dsh-ria 仓库实现会话：JavaScript/Node、Router/ticket、测试；workspace 为 dsh-ria。',
    },
    {
      id: 'session:docs',
      kind: 'session',
      label: 'docs',
      description: '文档会话：设计文档、README、实验报告；workspace 为 dsh-ria/docs。',
    },
    {
      id: 'session:ui',
      kind: 'session',
      label: 'ui',
      description: 'Web UI 会话：布局、CSS、组件、窄屏适配；workspace 为 web-ui。',
    },
    {
      id: 'new_session',
      kind: 'action',
      label: 'new_session',
      description: '没有合适现有会话，或需要不同 workspace、干净上下文时新建会话。',
    },
    {
      id: 'ask',
      kind: 'action',
      label: 'ask',
      description: '信息不足，先询问用户。',
    },
    {
      id: 'return_to_think',
      kind: 'action',
      label: 'return_to_think',
      description: 'WorkOrder 不完整或冲突，退回 Think 重写；不要用它逃避执行。',
    },
  ],
}

export const cases = [
  {
    id: 'p1',
    mode: 'project',
    request: '把 Ria 看板的卡片按项目分组，并加一个“需要你”的收件箱；先不要动前端样式细节。',
    acceptable: ['project:dsh-ria'],
  },
  {
    id: 'p2',
    mode: 'project',
    request: '修一下 Web UI 在 320px 宽度下侧边栏遮挡内容的问题，只改布局和 CSS。',
    acceptable: ['project:web-ui'],
  },
  {
    id: 'p3',
    mode: 'project',
    request: '把所有项目的 Node 版本统一到 24，并检查本地代理端口 8787/7878 的启动脚本。',
    acceptable: ['project:infra', 'global'],
  },
  {
    id: 'p4',
    mode: 'project',
    request: '把那个东西改一下，保持和之前一致。',
    acceptable: ['ask'],
  },
  {
    id: 'p5',
    mode: 'project',
    request: 'Ria 的 SQLite 迁移和 Web UI 的加载状态一起做，先给一个跨项目计划。',
    acceptable: ['global'],
  },
  {
    id: 'p6',
    mode: 'project',
    request: '给 Router 写一个实验脚本，测项目路由和 session 路由，模型用 FRIDAY/deepseek v4.1 flash。',
    acceptable: ['project:dsh-ria'],
  },
  {
    id: 's1',
    mode: 'session',
    request: '实现 Router 的 request 打分与规则路由，补测试，并在 dsh-ria 仓库跑通。',
    acceptable: ['session:impl'],
  },
  {
    id: 's2',
    mode: 'session',
    request: '把 Router 设计写成 docs/router.md，附上实验结果和边界说明。',
    acceptable: ['session:docs'],
  },
  {
    id: 's3',
    mode: 'session',
    request: '修 board 卡片在 320px 宽度下的布局，只改 CSS。',
    acceptable: ['session:ui'],
  },
  {
    id: 's4',
    mode: 'session',
    request: '把那个方案落地，保持和之前一致。',
    acceptable: ['ask', 'return_to_think'],
  },
  {
    id: 's5',
    mode: 'session',
    request: '同时改 SQLite 迁移、前端加载状态和 Router 测试，今天要全部完成。',
    acceptable: ['return_to_think', 'ask'],
  },
  {
    id: 's6',
    mode: 'session',
    request: '在 dsh-ria 仓库里补一个 Router prompt 的单元测试，不写文档。',
    acceptable: ['session:impl'],
  },
]

export function defaultCandidates(mode) {
  const list = candidates[mode]
  if (!list) throw new Error('unknown routing mode: ' + String(mode))
  return list.map(candidate => ({ ...candidate }))
}
