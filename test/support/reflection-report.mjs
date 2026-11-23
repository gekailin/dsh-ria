export function reflectionReportMarkdown(run, status = 'complete', options = {}) {
  const executorSessionId = run.executorSessionId || 'session-test-executor'
  const heading = value => (options.omitHeading === value ? null : '## ' + value)
  const iteration = options.iteration === undefined ? '无' : options.iteration
  const lines = [
    '---',
    'schema: 2',
    'date: ' + run.forDate,
    'timezone: Asia/Shanghai',
    'cadence: daily',
    'windowStart: ' + new Date(run.windowStart).toISOString(),
    'windowEnd: ' + new Date(run.windowEnd).toISOString(),
    'trigger: ' + run.trigger,
    'runId: ' + run.runId,
    'attempt: ' + run.attempt,
    'executorSessionId: ' + executorSessionId,
    'status: ' + status,
    'sessionsReviewed: 1',
    'sessionsSkipped: 0',
    'ticketsReviewed: 1',
    'compressedBytesRead: 0',
    'decompressedBytesRead: 0',
    'durationMs: 0',
    'degraded: []',
    '---',
  ]
  for (const value of ['一句话', '做对了什么', '错漏清单', '教训']) {
    const line = heading(value)
    if (line) lines.push(line, options.body && options.body[value] ? options.body[value] : '没有新的证据。', '')
  }
  const iterationHeading = heading('对 dsh-ria 的迭代建议')
  if (iterationHeading) lines.push(iterationHeading, iteration, '')
  for (const value of ['memory 候选', '明日关注', '覆盖与成本', '未覆盖']) {
    const line = heading(value)
    if (line) lines.push(line, options.body && options.body[value] ? options.body[value] : '没有新的证据。', '')
  }
  return lines.join('\n') + '\n'
}
