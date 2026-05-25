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
//   ① PID lockfile 单例锁 — 启动旧进程活则落 last-startup-error.json + exit 0；每 tick 校验 pid 文件仍是自己
//   ② stdout EPIPE 容错自杀 — 单轮不可写 skip 当轮，连续 3 轮（~90s）才 exit 防污染 poll.emitted；
//      退出前写 events.log 留诊断痕迹（瞬断不死，真断才死）
//   ③ state.last_processed_time 未来值防御 — 超 now+60s 自愈 + emit BOT_ERROR
//
// 注：v0.1.11 试过 Defense ④ 父进程死亡自杀（ppid 重读 / process.kill(pid,0) 探活），但 cc-bot-test
// Windows 实测发现进程链 CC → bash → poll.js 中 CC 死后 bash 孤儿不死，poll.js.ppid（=bash PID）不变
// → 检测失效；POSIX 推测同因（bash 被 init/launchd 接管但仍活）。撤回，待跨平台反向追溯 CC PID 方案
// 成熟再补（v0.1.12+ 候选）。CC 崩溃场景由 ② EPIPE 90s 兜底（实战验证稳）。

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
const LAST_STARTUP_ERROR_FILE = path.join(RUNTIME_DIR, 'last-startup-error.json')

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
const IM_MODE = im.type === 'slack' ? 'push' : 'polling'  // slack = Socket Mode push；lark = polling
let adapter
try {
  if (im.type === 'lark') {
    if (!im.bot_app_id || !im.chat_id) {
      console.log(`BOT_ERROR|poll.js|profile-invalid|lark 需要 im.bot_app_id 和 im.chat_id`)
      process.exit(1)
    }
    const { LarkAdapter } = require(path.join(__dirname, '..', 'adapters', 'lark'))
    adapter = new LarkAdapter({ botAppId: im.bot_app_id })
  } else if (im.type === 'slack') {
    const extra = im.extra || {}
    if (!extra.bot_token || !extra.app_token || !im.bot_user_id || !im.chat_id) {
      console.log(`BOT_ERROR|poll.js|profile-invalid|slack 需要 im.extra.bot_token / im.extra.app_token / im.bot_user_id / im.chat_id`)
      process.exit(1)
    }
    const { SlackAdapter } = require(path.join(__dirname, '..', 'adapters', 'slack'))
    adapter = new SlackAdapter({
      botToken: extra.bot_token,
      appToken: extra.app_token,
      botUserId: im.bot_user_id,
    })
  } else {
    console.log(`BOT_ERROR|poll.js|unsupported-im|im.type=${im.type} 暂不支持`)
    process.exit(1)
  }
} catch (err) {
  console.log(`BOT_ERROR|poll.js|adapter-init|${err.message}`)
  process.exit(1)
}

const CHAT_ID = im.chat_id
const BOT_OPEN_ID = im.bot_open_id || im.bot_user_id || ''  // lark 用 bot_open_id / slack 用 bot_user_id；未配时保守 — 任何 @ 一律 skip
// locale 决策：profile 显式优先 → 按 IM 类型默认（lark=zh-CN / slack=en-US）→ 兜底 zh-CN
// 影响范围：bot 主动发起的系统文案（busy 占位 / 上下线通知）；不影响 LLM 跟用户对话的语言
const DEFAULT_LOCALE_BY_IM = { lark: 'zh-CN', slack: 'en-US' }
const LOCALE = im.locale || DEFAULT_LOCALE_BY_IM[im.type] || 'zh-CN'
const CHECK_INTERVAL_MS = Number(profile.polling_interval_ms) || 30 * 1000
const PAGE_SIZE = 10
const EMITTED_MAX = 200
const VALID_TYPES = new Set(['text', 'post', 'file', 'image'])
const FAIL_ALERT_THRESHOLD = 4
const FUTURE_TIME_TOLERANCE_MS = 60 * 1000

// 主会话忙碌锁（CC UserPromptSubmit/Stop hook 写入）
const MAIN_BUSY_LOCK = path.join(RUNTIME_DIR, 'main-busy.lock')
const MAIN_BUSY_NOTIFIED_FLAG = path.join(RUNTIME_DIR, 'main-busy-notified.flag')
const MAIN_BUSY_TTL_MS = 10 * 60 * 1000  // 10min 硬编码过期兜底

// 降级模式心跳检测（v0.1.15）：锁过期时用 hud-stdin.json 更新时间区分「孤儿锁」vs「主会话卡死」
const HUD_STDIN_FILE = path.join(RUNTIME_DIR, 'hud-stdin.json')
const MAIN_BUSY_HEARTBEAT_STALE_MS = 5 * 60 * 1000  // 5min — statusline 无更新视为会话卡死
const MAIN_BUSY_DEGRADED_PLACEHOLDER_INTERVAL_MS = 5 * 60 * 1000  // 5min — 降级模式占位重发间隔

// 主会话忙碌时的群占位文案池（每次随机一条，避免机械重复）。
// 按 locale 选池：zh-CN / en-US。两套都保留 emoji + 自嘲风格（cc-bot 是「群里的开发同事」人设）。
const BUSY_PLACEHOLDERS_BY_LOCALE = {
  'zh-CN': [
    '⏳ 主会话在忙，稍后回你',
    '☕ 手头忙，消息记下了',
    '⌨️ 在敲代码，稍等啊..',
    '💭 思考中，过会儿回话',
    '🔧 在修东西，稍等..',
    '📝 正在写东西，消息排队了',
    '🏃 跑任务中，马上回来',
    '🎯 专注中，稍后回你',
    '🫖 正在泡茶，等一下下',
    '🐢 我手慢，请多担待',
    '🧩 拼图差一块，马上好',
    '🔭 对焦中，别急..',
    '📮 消息已签收.',
    '🎮 在打个小 boss..',
    '🐛 在抓 bug..',
    '🔨 锤代码呢',
    '📚 等等...',
    '💾 读档中，马上',
    '⚙️ 齿轮转着呢',
    '🛠️ 工具箱翻找中',
    '🥱 脑子慢，多包涵',
    '🙃 卡壳了，给点时间',
    '🐌 蜗牛速度，但在前进',
    '🤹 多线程杂耍中',
    '😵‍💫 大脑过载..',
    '🪄 咒语念到一半',
    '🎩 召唤代码精灵中',
    '🔄 转圈圈中，别走开',
    '📶 信号微弱，努力中',
    '🍜 泡面三分钟',
  ],
  'en-US': [
    '⏳ Main thread busy, hang tight',
    '☕ Got it, message queued',
    '⌨️ Coding away, one sec..',
    '💭 Thinking it over, brb',
    '🔧 Fixing something, hold on..',
    '📝 Writing stuff, message lined up',
    '🏃 Running tasks, back soon',
    '🎯 Focused, will get to you',
    '🫖 Brewing tea, just a moment',
    '🐢 Bear with my slow pace',
    '🧩 One piece missing, almost there',
    '🔭 Focusing in, hold on..',
    '📮 Message received.',
    '🎮 Fighting a mini-boss..',
    '🐛 Hunting bugs..',
    '🔨 Hammering code',
    '📚 Just a sec...',
    '💾 Loading save file, almost',
    '⚙️ Gears are turning',
    '🛠️ Digging through the toolbox',
    '🥱 Slow brain, bear with me',
    '🙃 Stuck, need a moment',
    '🐌 Snail pace but moving',
    '🤹 Juggling threads',
    '😵‍💫 Brain overloaded..',
    '🪄 Mid-incantation',
    '🎩 Summoning code sprites',
    '🔄 Spinning, don\'t leave',
    '📶 Weak signal, trying..',
    '🍜 Three-minute noodle',
  ],
}
function pickBusyPlaceholder() {
  const pool = BUSY_PLACEHOLDERS_BY_LOCALE[LOCALE] || BUSY_PLACEHOLDERS_BY_LOCALE['zh-CN']
  return pool[Math.floor(Math.random() * pool.length)]
}

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
      console.log(`BOT_INFO|poll.js|lock-taken-by-pid-${existing}|另一个实例已在跑，本进程退出（详情见 runtime/last-startup-error.json）`)
      // 落盘启动失败记录：30s 窗口期撞车 / 真有合法实例并存时给 doctor + 用户可见反馈，
      // 不再静默 exit(0)。群提示不在此发——交主会话收到上方 BOT_INFO notification 后决定。
      try {
        fs.writeFileSync(LAST_STARTUP_ERROR_FILE, JSON.stringify({
          ts: Date.now(),
          iso: new Date().toISOString(),
          reason: 'lock-taken',
          pid: process.pid,
          blocked_by_pid: Number(existing),
          message: `acquireLock 失败：poll.pid 被活进程 ${existing} 持有，本进程 ${process.pid} 退出。若确认 ${existing} 是孤儿，杀掉它并删除 poll.pid 后重启`,
        }, null, 2), 'utf8')
      } catch {}
      process.exit(0)
    }
  } catch {}
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8')
  } catch {}
  // 成功取锁 → 清掉可能残留的上次启动失败记录（doctor 据此判断「上次启动是否正常」）
  try { fs.unlinkSync(LAST_STARTUP_ERROR_FILE) } catch {}
  // 注意：main-busy.lock 故意不在此清理（与 poll.pid / poll.emitted 不同策略）。
  // 原因：启动 bot 时 CC 主窗口可能正在对话（hook 已写 lock），清掉会让群消息
  // 立刻 emit 打断主窗口任务；残留过期 lock 由 checkMainBusy() 10min 自动清。
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

// ========== Defense 2: stdout EPIPE 容错（瞬断 skip，真断 exit） ==========

const EPIPE_TOLERATE = 3  // 连续 N 轮 stdout 不可写才 exit（~N × polling_interval）
const EVENTS_LOG = path.join(RUNTIME_DIR, 'events.log')
let epipeStreak = 0

function logEvent(line) {
  // 破例允许 events.log 写入，用于 stdout 真断后的诊断痕迹（polling 架构常规不写）
  try {
    fs.appendFileSync(EVENTS_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function checkStdoutTolerance() {
  if (!process.stdout.writable) {
    epipeStreak++
    if (epipeStreak >= EPIPE_TOLERATE) {
      logEvent(`BOT_ERROR|poll.js|stdout-closed-streak-${epipeStreak}|连续 ${epipeStreak} 轮 stdout 不可写，退出防污染 poll.emitted`)
      releaseLock()
      process.exit(1)
    }
    return false
  }
  epipeStreak = 0
  return true
}

process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') {
    epipeStreak++
    if (epipeStreak >= EPIPE_TOLERATE) {
      logEvent(`BOT_ERROR|poll.js|stdout-epipe-streak-${epipeStreak}|连续 EPIPE，退出防污染 poll.emitted`)
      releaseLock()
      process.exit(1)
    }
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

// ========== @他人消息过滤（v0.1.10）==========
// mentions 非空 + bot 不在 mention 列表 → 视为 @他人，skip emit。
// BOT_OPEN_ID 未配时保守：任何 mentions 非空都 skip（@bot 也会被忽略，等用户配 bot_open_id 才精准）。
function isAtOthers(mentions) {
  if (!Array.isArray(mentions) || mentions.length === 0) return false
  if (!BOT_OPEN_ID) return true  // 保守模式
  return !mentions.some(mt => mt && mt.id && mt.id.open_id === BOT_OPEN_ID)
}

// ========== 主会话优先级：锁检测 + 占位 ==========

function getHeartbeatAge() {
  try {
    return Date.now() - fs.statSync(HUD_STDIN_FILE).mtimeMs
  } catch {
    return -1  // 文件不存在
  }
}

function checkMainBusy() {
  try {
    const raw = fs.readFileSync(MAIN_BUSY_LOCK, 'utf8')
    const data = JSON.parse(raw)
    const ts = Number(data.ts || 0)
    if (Date.now() - ts > MAIN_BUSY_TTL_MS) {
      // 锁过期 → 查心跳区分「孤儿锁」vs「主会话卡死」
      const heartbeatAge = getHeartbeatAge()
      if (heartbeatAge >= 0 && heartbeatAge < MAIN_BUSY_HEARTBEAT_STALE_MS) {
        // 心跳新鲜 → 会话存活，锁是孤儿（Stop 漏 fire/unlock 失败），安全清锁恢复 emit
        logEvent(`BOT_WARN|poll.js|main-busy-lock-expired-orphan|ttl-${MAIN_BUSY_TTL_MS}ms|heartbeat-${Math.round(heartbeatAge / 1000)}s|session=${data.session || 'unknown'}`)
        try { fs.unlinkSync(MAIN_BUSY_LOCK) } catch {}
        try { fs.unlinkSync(MAIN_BUSY_NOTIFIED_FLAG) } catch {}
        return false
      }
      // 心跳陈旧/缺失 → 主会话极可能卡死（AskUserQuestion 等阻塞交互），进入降级模式
      logEvent(`BOT_ERROR|poll.js|main-busy-lock-expired-degraded|ttl-${MAIN_BUSY_TTL_MS}ms|heartbeat-${heartbeatAge < 0 ? 'missing' : Math.round(heartbeatAge / 1000) + 's'}|session=${data.session || 'unknown'}`)
      return true  // 保持 busy，不 emit，持续发占位
    }
    return true
  } catch {
    return false
  }
}

async function sendMainBusyPlaceholder() {
  try {
    if (fs.existsSync(MAIN_BUSY_NOTIFIED_FLAG)) {
      // 降级模式：flag 超过间隔后清除，下轮重发占位（避免长阻塞后期纯静默）
      const flagAge = Date.now() - fs.statSync(MAIN_BUSY_NOTIFIED_FLAG).mtimeMs
      if (flagAge < MAIN_BUSY_DEGRADED_PLACEHOLDER_INTERVAL_MS) return
      try { fs.unlinkSync(MAIN_BUSY_NOTIFIED_FLAG) } catch {}
    }
  } catch { return }
  try {
    await adapter.sendText({ chatId: CHAT_ID, text: pickBusyPlaceholder() })
    fs.writeFileSync(MAIN_BUSY_NOTIFIED_FLAG, String(Date.now()))
  } catch {
    // 占位发送失败静默 — 主业务不受影响
  }
}

async function tick() {
  if (!checkStdoutTolerance()) return
  verifyLock()

  let state = readState()
  state = guardFutureTime(state)

  if (state.paused) return

  const mainBusy = checkMainBusy()

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
  let busySeenNew = false

  for (const m of asc) {
    if (!m.id) continue
    if (emitted.has(m.id)) continue
    if (m.senderType === 'bot') continue
    if (!VALID_TYPES.has(m.type)) continue
    if (!m.createTimeMs || m.createTimeMs <= lastTime) continue

    // @他人过滤：视为已处理（append emitted），下次不再扫
    if (isAtOthers(m.mentions)) {
      newlyEmitted.push(m.id)
      continue
    }

    if (mainBusy) {
      // 主窗口忙：不 emit、不记 emitted，等解锁后下一 tick 正常处理
      busySeenNew = true
      continue
    }
    console.log(`NEW_MSG|${m.id}|${m.senderId}|${m.content}|${m.createTimeMs}`)
    newlyEmitted.push(m.id)
  }

  if (mainBusy && busySeenNew) await sendMainBusyPlaceholder()
  if (newlyEmitted.length > 0) appendEmitted(newlyEmitted)
}

// self-poll 单次模式：跑一次拉取，输出新消息到 stdout 后退出（由 /loop 每轮驱动，不依赖 Monitor）。
// 复用 tick 的过滤/去重逻辑，但不做 mainBusy/EPIPE/lock/常驻（单次执行不需要）。
async function pollOnce() {
  let state = readState()
  state = guardFutureTime(state)
  if (state.paused) return
  const msgs = await pollMessages()
  if (msgs === null) {
    console.log(`BOT_ERROR|poll.js|once|adapter 拉取失败（认证过期或网络故障）`)
    process.exitCode = 1
    return
  }
  if (msgs.length === 0) return
  const lastTime = Number(state.last_processed_time || 0)
  const emitted = readEmitted()
  const asc = [...msgs].reverse()
  const newlyEmitted = []
  for (const m of asc) {
    if (!m.id) continue
    if (emitted.has(m.id)) continue
    if (m.senderType === 'bot') continue
    if (!VALID_TYPES.has(m.type)) continue
    if (!m.createTimeMs || m.createTimeMs <= lastTime) continue
    if (isAtOthers(m.mentions)) { newlyEmitted.push(m.id); continue }
    console.log(`NEW_MSG|${m.id}|${m.senderId}|${m.content}|${m.createTimeMs}`)
    newlyEmitted.push(m.id)
  }
  if (newlyEmitted.length > 0) appendEmitted(newlyEmitted)
}

// ========== 启动 ==========

const ONCE_MODE = process.argv.includes('--once')  // self-poll：跑一次输出后退出

function scheduleTick() {
  tick().finally(() => setTimeout(scheduleTick, CHECK_INTERVAL_MS))
}

// Push 模式（slack）：单条到达，复用 tick 内部的过滤/emit 逻辑
async function handlePushMessage(m) {
  if (!checkStdoutTolerance()) return
  verifyLock()

  let state = readState()
  state = guardFutureTime(state)
  if (state.paused) return

  const mainBusy = checkMainBusy()
  const lastTime = Number(state.last_processed_time || 0)
  const emitted = readEmitted()

  if (!m || !m.id) return
  if (emitted.has(m.id)) return
  if (m.senderType === 'bot') return
  if (!VALID_TYPES.has(m.type)) return
  if (!m.createTimeMs || m.createTimeMs <= lastTime) return

  if (isAtOthers(m.mentions)) {
    appendEmitted([m.id])
    return
  }

  if (mainBusy) {
    // push 模式必须立刻 emit — 没有"下一 tick 重新 fetch"机制，错过 push 永久丢失。
    // 主会话忙时 CC 会自动把 notification 排队，忙完按顺序处理 → 消息不丢 + 不打断主会话节奏。
    // busy 占位仍只发一次（sendMainBusyPlaceholder 内部有 NOTIFIED_FLAG 去重）防刷屏。
    console.log(`NEW_MSG|${m.id}|${m.senderId}|${m.content}|${m.createTimeMs}`)
    appendEmitted([m.id])
    await sendMainBusyPlaceholder()
    return
  }

  console.log(`NEW_MSG|${m.id}|${m.senderId}|${m.content}|${m.createTimeMs}`)
  appendEmitted([m.id])
}

async function startPushMode() {
  try {
    await adapter.startListening({
      chatId: CHAT_ID,
      onMessage: (m) => {
        handlePushMessage(m).catch(err => {
          console.log(`BOT_ERROR|poll.js|push-handler|${err.message}`)
        })
      },
      onError: (err) => {
        console.log(`BOT_ERROR|poll.js|push-stream|${err && err.message || String(err)}`)
      },
    })
    console.log(`BOT_INFO|poll.js|push-listening|${im.type}|${CHAT_ID}`)
  } catch (err) {
    console.log(`BOT_ERROR|poll.js|push-start|${err.message}`)
    process.exit(1)
  }
}

if (ONCE_MODE) {
  // self-poll 单次模式：不取锁、不常驻，跑一次输出新消息后退出（由 /loop 每轮驱动）
  pollOnce()
    .then(() => process.exit(process.exitCode || 0))
    .catch((err) => { console.log(`BOT_ERROR|poll.js|once|${(err && err.message) || err}`); process.exit(1) })
} else {
  // 常驻模式（Monitor 托管）：与改动前逐字一致，零回归
  acquireLock()
  process.on('exit', releaseLock)
  process.on('SIGINT', () => { releaseLock(); process.exit(0) })
  process.on('SIGTERM', () => { releaseLock(); process.exit(0) })
  process.on('uncaughtException', () => {})
  process.on('unhandledRejection', () => {})
  if (IM_MODE === 'push') setTimeout(startPushMode, 1000)
  else setTimeout(scheduleTick, 1000)
}
