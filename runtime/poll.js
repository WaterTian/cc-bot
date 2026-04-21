#!/usr/bin/env node
// cc-bot API 轮询 — Monitor 工具的主事件源。
//
// 每 N 秒通过 IMAdapter.listRecentMessages() 拉最近消息，对比 state.last_processed_time
// + runtime/poll.emitted 去重，emit NEW_MSG 到 stdout。Claude Code Monitor 捕获为 notification
// 推送到主会话。
//
// 用法：
//   node runtime/poll.js --project <abs-path>
//   CC_BOT_PROJECT=<abs-path> node runtime/poll.js
//
// Profile：<project>/.cc-bot/profiles/active.json
//   {
//     "im": { "type": "lark", "bot_app_id": "...", "chat_id": "..." },
//     "polling_interval_ms": 30000   // 可选
//   }
//
// 三层防御（2026-04-20 polling 架构三坑对策，不可删除）：
//   ① PID lockfile 单例锁 — 启动旧进程活则 exit 0；每 tick 校验 pid 文件仍是自己
//   ② stdout.writable + EPIPE — Monitor 管道断则自杀，防孤儿污染 poll.emitted
//   ③ state.last_processed_time 未来值防御 — 超 now+60s 自愈 + emit BOT_ERROR

const fs = require('fs')
const path = require('path')

// ========== 参数解析 ==========

function parseProjectRoot() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--project')
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1])
  if (process.env.CC_BOT_PROJECT) return path.resolve(process.env.CC_BOT_PROJECT)
  console.log(`BOT_ERROR|poll.js|no-project|必须指定 --project <abs-path> 或 CC_BOT_PROJECT 环境变量`)
  process.exit(1)
}

const PROJECT_ROOT = parseProjectRoot()
const CCB_DIR = path.join(PROJECT_ROOT, '.cc-bot')
const PROFILE_FILE = path.join(CCB_DIR, 'profiles', 'active.json')
const RUNTIME_DIR = path.join(CCB_DIR, 'runtime')
const STATE_FILE = path.join(RUNTIME_DIR, 'state.json')
const EMITTED_FILE = path.join(RUNTIME_DIR, 'poll.emitted')
const PID_FILE = path.join(RUNTIME_DIR, 'poll.pid')

try { fs.mkdirSync(RUNTIME_DIR, { recursive: true }) } catch {}

// ========== Profile & Adapter ==========

function loadProfile() {
  try {
    return JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'))
  } catch {
    return null
  }
}

const profile = loadProfile()
if (!profile || !profile.im || !profile.im.type) {
  console.log(`BOT_ERROR|poll.js|profile-missing|${PROFILE_FILE} 缺失或缺 im.type`)
  process.exit(1)
}

const im = profile.im
let adapter
try {
  if (im.type === 'lark') {
    if (!im.bot_app_id || !im.chat_id) {
      console.log(`BOT_ERROR|poll.js|profile-invalid|lark 需要 im.bot_app_id 和 im.chat_id`)
      process.exit(1)
    }
    const { LarkAdapter } = require(path.join(__dirname, '..', 'adapters', 'lark'))
    adapter = new LarkAdapter({ botAppId: im.bot_app_id })
  } else {
    console.log(`BOT_ERROR|poll.js|unsupported-im|im.type=${im.type} 暂不支持`)
    process.exit(1)
  }
} catch (err) {
  console.log(`BOT_ERROR|poll.js|adapter-init|${err.message}`)
  process.exit(1)
}

const CHAT_ID = im.chat_id
const CHECK_INTERVAL_MS = Number(profile.polling_interval_ms) || 30 * 1000
const PAGE_SIZE = 10
const EMITTED_MAX = 200
const VALID_TYPES = new Set(['text', 'post', 'file', 'image'])
const FAIL_ALERT_THRESHOLD = 4
const FUTURE_TIME_TOLERANCE_MS = 60 * 1000

let consecutiveFailures = 0
let alertedOnce = false

// ========== Defense 1: PID lockfile 单例锁 ==========

function pidAlive(pid) {
  if (!pid || !/^\d+$/.test(pid)) return false
  try {
    // 用信号 0 探测（Windows node 在进程已死时抛 ESRCH）
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

function acquireLock() {
  try {
    const existing = fs.readFileSync(PID_FILE, 'utf8').trim()
    if (existing && pidAlive(existing)) {
      console.log(`BOT_INFO|poll.js|lock-taken-by-pid-${existing}|另一个实例已在跑，本进程退出`)
      process.exit(0)
    }
  } catch {}
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8')
  } catch {}
}

function verifyLock() {
  try {
    const pidInFile = fs.readFileSync(PID_FILE, 'utf8').trim()
    if (pidInFile && pidInFile !== String(process.pid)) {
      process.exit(0)
    }
  } catch {}
}

function releaseLock() {
  try {
    const pidInFile = fs.readFileSync(PID_FILE, 'utf8').trim()
    if (pidInFile === String(process.pid)) fs.unlinkSync(PID_FILE)
  } catch {}
}

// ========== Defense 2: stdout.writable + EPIPE ==========

function assertStdoutAlive() {
  if (!process.stdout.writable) {
    releaseLock()
    process.exit(1)
  }
}

process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') {
    releaseLock()
    process.exit(1)
  }
})

// ========== Defense 3: state.last_processed_time 未来值 ==========

function guardFutureTime(state) {
  const lastTime = Number(state.last_processed_time || 0)
  const now = Date.now()
  if (lastTime > now + FUTURE_TIME_TOLERANCE_MS) {
    const safeTime = now - 60 * 1000
    const fixed = { ...state, last_processed_time: String(safeTime) }
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(fixed))
    } catch {}
    console.log(`BOT_ERROR|poll.js|state-future-timestamp|last=${lastTime} > now+${FUTURE_TIME_TOLERANCE_MS}ms，已降到 ${safeTime}；可能漏历史消息`)
    return fixed
  }
  return state
}

// ========== 核心轮询逻辑 ==========

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function readEmitted() {
  try {
    const lines = fs.readFileSync(EMITTED_FILE, 'utf8').split('\n').filter(Boolean)
    return new Set(lines)
  } catch {
    return new Set()
  }
}

function appendEmitted(msgIds) {
  fs.appendFileSync(EMITTED_FILE, msgIds.map(id => id + '\n').join(''))
  try {
    const lines = fs.readFileSync(EMITTED_FILE, 'utf8').split('\n').filter(Boolean)
    if (lines.length > EMITTED_MAX) {
      fs.writeFileSync(EMITTED_FILE, lines.slice(-EMITTED_MAX).join('\n') + '\n')
    }
  } catch {}
}

async function pollMessages() {
  try {
    const msgs = await adapter.listRecentMessages({ chatId: CHAT_ID, pageSize: PAGE_SIZE })
    consecutiveFailures = 0
    alertedOnce = false
    return msgs
  } catch {
    consecutiveFailures++
    return null
  }
}

async function tick() {
  assertStdoutAlive()
  verifyLock()

  let state = readState()
  state = guardFutureTime(state)

  if (state.paused) return

  const msgs = await pollMessages()
  if (msgs === null) {
    if (consecutiveFailures >= FAIL_ALERT_THRESHOLD && !alertedOnce) {
      console.log(`BOT_ERROR|poll.js|adapter 连续失败 ${consecutiveFailures} 次，可能认证过期或网络故障`)
      alertedOnce = true
    }
    return
  }
  if (msgs.length === 0) return

  const lastTime = Number(state.last_processed_time || 0)
  const emitted = readEmitted()
  // adapter 返回降序，翻成升序处理
  const asc = [...msgs].reverse()
  const newlyEmitted = []

  for (const m of asc) {
    if (!m.id) continue
    if (emitted.has(m.id)) continue
    if (m.senderType === 'bot') continue
    if (!VALID_TYPES.has(m.type)) continue
    if (!m.createTimeMs || m.createTimeMs <= lastTime) continue

    console.log(`NEW_MSG|${m.id}|${m.senderId}|${m.content}|${m.createTimeMs}`)
    newlyEmitted.push(m.id)
  }

  if (newlyEmitted.length > 0) appendEmitted(newlyEmitted)
}

// ========== 启动 ==========

acquireLock()

process.on('exit', releaseLock)
process.on('SIGINT', () => { releaseLock(); process.exit(0) })
process.on('SIGTERM', () => { releaseLock(); process.exit(0) })
process.on('uncaughtException', () => {})
process.on('unhandledRejection', () => {})

function scheduleTick() {
  tick().finally(() => setTimeout(scheduleTick, CHECK_INTERVAL_MS))
}
setTimeout(scheduleTick, 1000)
