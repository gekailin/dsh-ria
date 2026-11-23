// TEMPORARY one-shot migration: retire the lessons library into cognition.
// Mapping is explicit and stable by lesson id. The real DB is only read.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const LESSON_COGNITION_MAP = Object.freeze({
  les_mwmokkvc_6952416e: { file: 'decisions.md', reason: '派单/projectCwd 踩坑结论，属于流程决策' },
  les_mwmokkvi_889cb8cd: { file: 'decisions.md', reason: '审批等待与状态机流程决策' },
  les_mwmokkvp_468aa38e: { file: 'decisions.md', reason: '审批超时/预算处理决策' },
  les_mwmokkvt_85ab2c55: { file: 'decisions.md', reason: '部署与重启验收流程决策' },
  les_mwmorazz_c3ab1775: { file: 'decisions.md', reason: '审批风险判定实现决策' },
  les_mwmorb05_0bd4388f: { file: 'agreements.md', reason: '审计 exactly-once 的协作约定' },
  les_mwmp7jvy_26cf4022: { file: 'decisions.md', reason: '状态写入口与过程事件实现决策' },
  les_mwmp7jw4_fd672b60: { file: 'agreements.md', reason: 'HTTP 精确路径的约定' },
})

const lessonMarker = id => '<!-- lesson:' + id + ' -->'

function readLessons(dbPath) {
  if (!existsSync(dbPath)) return []
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    return db.prepare('SELECT * FROM lessons ORDER BY created_at, id').all()
  } catch { return [] } finally { try { db && db.close() } catch {} }
}

function renderLesson(row) {
  const lines = [
    lessonMarker(row.id),
    '### ' + String(row.scenario || row.id),
    '- 坑：' + String(row.pitfall || '（无）'),
    '- 做法：' + String(row.approach || '（无）'),
  ]
  if (row.evidence) lines.push('- 证据：' + String(row.evidence))
  if (row.ticket_id) lines.push('- 来源工单：' + String(row.ticket_id))
  if (!LESSON_COGNITION_MAP[row.id]) lines.push('- 迁移：未分类，默认 decisions')
  return lines.join('\n') + '\n\n'
}

/**
 * Migrate each lessons row once into cognition/chat/<mapped file>. A backup of
 * cognition/ is taken before the first actual write; reruns skip markers.
 */
export function migrateLessonsToCognition({ stateDir, dbPath = join(stateDir, 'ria.sqlite'), lessons = null, now = Date.now() } = {}) {
  const rows = Array.isArray(lessons) ? lessons : readLessons(dbPath)
  if (!rows.length) return { migrated: 0, skipped: 0, backupDir: null, files: [] }
  const cognition = join(stateDir, 'cognition')
  const chat = join(cognition, 'chat')
  mkdirSync(chat, { recursive: true })
  const pending = []
  const files = new Set()
  for (const row of rows) {
    if (!row || !row.id) continue
    const target = join(chat, (LESSON_COGNITION_MAP[row.id] || {}).file || 'decisions.md')
    const marker = lessonMarker(row.id)
    let existing = ''
    try { existing = readFileSync(target, 'utf8') } catch {}
    if (existing.includes(marker)) continue
    pending.push({ target, text: renderLesson(row) })
    files.add(target)
  }
  if (!pending.length) return { migrated: 0, skipped: rows.length, backupDir: null, files: [] }
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const backupDir = join(stateDir, 'cognition.bak.' + stamp)
  cpSync(cognition, backupDir, { recursive: true })
  const written = []
  for (const item of pending) {
    let current = ''
    try { current = readFileSync(item.target, 'utf8') } catch {}
    const separator = current && !current.endsWith('\n\n') ? '\n' : ''
    writeFileSync(item.target, current + separator + item.text)
    written.push(item.target)
  }
  return { migrated: written.length, skipped: rows.length - written.length, backupDir, files: written }
}
