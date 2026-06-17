#!/usr/bin/env node
// cc-bot PreToolUse hook bridge — 把 TodoWrite / TaskCreate / TaskUpdate 自动 mirror 到当前流式卡片。
//
// 设计：worker 接到任务后用 TodoWrite 管自己的待办（subagent 工具集 v0.1.32+ 含 TodoWrite），
// 每次 TodoWrite 更新 → PreToolUse hook 触发 → 本桥读 cwd / agents.json / 缓存做 diff →
// 把新增 / 完成的待办行追加到 streaming-card.js report，群里实时看到 ▸ / ✓ 进度，
// **worker 零额外报告负担**（worker 用 TodoWrite 本来就是 CC 标准管进度方式）。
//
// 触发：~/.claude/settings.json
//   PreToolUse  on matcher "TodoWrite|TaskCreate|TaskUpdate" → 本工具
//
// 流程：
//   1. 读 hook stdin payload（cwd / tool_name / tool_input / hook_event_name）
//   2. 过滤：cwd 下必须有 .cc-bot/profiles/active.json + im.type=lark + streaming_card.enabled
//   3. 读 .cc-bot/runtime/agents.json：running.length === 1 → 拿那条 msg_id（其它场景 v1 跳过）
//   4. 转换 tool call → 进度行：
//      a. TodoWrite（推荐主路径，subagent 用）：tool_input.todos 是完整 list →
//         diff 缓存的 lastTodos：新增 status!=completed → `▸ content`；status 转 completed → `✓ content`
//      b. TaskCreate（CC 主会话备用，本工程内自测用）：emit `▸ subject`
//      c. TaskUpdate status=completed：跳（v1 不缓存 id↔subject 映射）
//   5. spawn streaming-card.js report 异步 detached，hook 立即 exit 0 不阻塞主流程
//
// 永远 exit 0：失败任何环节静默退出，绝不阻塞主流程。

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { canUseStreamingCard } = require('./streaming-card-policy')
const { atomicWriteSync } = require('./atomic-write')

const STREAMING_CARD_CLI = path.join(__dirname, 'streaming-card.js')

function safeExit() { process.exit(0) }

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')) } catch { return null }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJsonSafe(file, obj) {
  try {
    atomicWriteSync(file, JSON.stringify(obj, null, 2))
  } catch {}
}

// === 主流程 ===

const payload = readStdin()
if (!payload || !payload.cwd) safeExit()
if (payload.hook_event_name !== 'PreToolUse') safeExit()

const cwd = payload.cwd
const ccBotDir = path.join(cwd, '.cc-bot')
const profilePath = path.join(ccBotDir, 'profiles', 'active.json')
if (!fs.existsSync(profilePath)) safeExit()

const profile = readJsonSafe(profilePath)
if (!profile) safeExit()
if (!canUseStreamingCard(profile).ok) safeExit()

// 找 running 任务的 msg_id
const agentsPath = path.join(ccBotDir, 'runtime', 'agents.json')
const agents = readJsonSafe(agentsPath) || { running: [], queue: [] }
const running = Array.isArray(agents.running) ? agents.running : []
let runMsgId = ''
if (running.length === 1) {
  runMsgId = running[0].msg_id || ''
}
// fan-out 多任务 / inline 无任务 → v1 跳过
if (!runMsgId) safeExit()

const cachePath = path.join(ccBotDir, 'runtime', `todo-bridge-${runMsgId}.json`)
let cache = readJsonSafe(cachePath) || {}

const { tool_name, tool_input } = payload

let progressLine = ''

if (tool_name === 'TodoWrite') {
  // tool_input.todos 是完整 list，每项形如 { content, activeForm?, status: 'pending'|'in_progress'|'completed' }
  const newTodos = Array.isArray(tool_input && tool_input.todos) ? tool_input.todos : []
  const lastTodos = Array.isArray(cache.lastTodos) ? cache.lastTodos : []
  const lastMap = new Map(lastTodos.map(t => [String(t.content || '').slice(0, 200), t]))
  const emitLines = []
  for (const t of newTodos) {
    const key = String(t.content || '').slice(0, 200)
    if (!key) continue
    const prev = lastMap.get(key)
    const label = String(t.activeForm || t.content || '').slice(0, 80)
    if (!prev) {
      // 新增 todo
      emitLines.push(t.status === 'completed' ? `✓ ${label}` : `▸ ${label}`)
    } else if (prev.status !== 'completed' && t.status === 'completed') {
      emitLines.push(`✓ ${label}`)
    }
  }
  cache.lastTodos = newTodos
  writeJsonSafe(cachePath, cache)
  if (emitLines.length === 0) safeExit()
  progressLine = emitLines.join('\n')
} else if (tool_name === 'TaskCreate') {
  const subject = (tool_input && tool_input.subject) ? String(tool_input.subject).slice(0, 80) : ''
  if (!subject) safeExit()
  const now = Date.now()
  const recent = Array.isArray(cache.recentSubjects) ? cache.recentSubjects : []
  const dup = recent.find(r => r.subject === subject && now - r.ts < 30 * 1000)
  if (dup) safeExit()
  recent.unshift({ subject, ts: now })
  cache.recentSubjects = recent.slice(0, 20)
  writeJsonSafe(cachePath, cache)
  progressLine = `▸ ${subject}`
} else {
  // TaskUpdate / 其他 → 跳（v1 不处理 id↔subject 映射）
  safeExit()
}

if (!progressLine) safeExit()

// 异步 spawn streaming-card.js report — hook 立即返回，不阻塞主流程
try {
  const child = spawn('node', [
    STREAMING_CARD_CLI,
    'report',
    '--project', cwd,
    '--msg-id', runMsgId,
    '--content', `\n${progressLine}`,
  ], { detached: true, stdio: 'ignore' })
  child.unref()
} catch {}

safeExit()
