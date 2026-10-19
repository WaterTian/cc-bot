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
//     "im": { "type": "lark", "bot_app_id": "...", "chat_id": "...", "chat_ids": [], "transport": "" },
//                                   // chat_ids（v0.1.51+，issue #24）：追加监听的群；chat_id 仍是主群
//     "polling_interval_ms": 60000,        // 可选（默认 60000 ms = 60s，v0.1.46+ 从 10s 调回 60s 省租户配额，issue #23）
//     "push_reconcile_interval_ms": 300000 // 可选（仅 im.transport='push' 时生效：校对轮询间隔，默认 5min）
//   }
//
// 传输模式（v0.1.49+，issue #23 Phase 3）：
//   lark 默认 HTTP polling；profile.im.transport='push' 显式 opt-in 走 `lark-cli event consume` 事件长连接
//   （事件不计飞书配额、实时到达），外加低频「校对轮询」兜底静默断流；长连接起不来 / 不可恢复 →
//   自动回落 polling（BOT_INFO|push-fallback），不中断服务。slack 固定 Socket Mode push。
//
// 三层防御（2026-04-20 polling 架构三坑对策，不可删除）：
//   ① PID lockfile 单例锁 — 启动旧进程活则落 last-startup-error.json + exit 0；每 tick 校验 pid 文件仍是自己
//   ② stdout EPIPE 容错自杀 — 单轮不可写 skip 当轮，连续 3 轮（≈3 个 tick：默认 60s → 3min，lark push 校对 5min → 15min）才 exit 防污染 poll.emitted；
//      退出前写 events.log 留诊断痕迹（瞬断不死，真断才死）
//   ③ state.last_processed_time 未来值防御 — 超 now+60s 自愈 + emit BOT_ERROR
//
// 注：v0.1.11 试过 Defense ④ 父进程死亡自杀（ppid 重读 / process.kill(pid,0) 探活），但 cc-bot-test
// Windows 实测发现进程链 CC → bash → poll.js 中 CC 死后 bash 孤儿不死，poll.js.ppid（=bash PID）不变
// → 检测失效；POSIX 推测同因（bash 被 init/launchd 接管但仍活）。撤回，待跨平台反向追溯 CC PID 方案
// 成熟再补（v0.1.12+ 候选）。CC 崩溃场景由 ② EPIPE 连续 3 tick 兜底（实战验证稳）。

const fs = require('fs')
const path = require('path')
const { atomicWriteSync } = require('./atomic-write')
const dispatchModule = require('./dispatch')
const botSwitchDetect = require('./bot-switch-detect')
const quotaAlert = require('./quota-alert')
const stallAlert = require('./stall-alert')
const permissionBridge = require('./permission-bridge')  // 只用 parseReply（模块已加 require.main 守卫，不会触发 hook 主流程）
const { createAdapter } = require('../adapters/factory')

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
// lark 默认 polling；im.transport='push' 显式 opt-in 事件长连接（v0.1.49+）。slack 固定 Socket Mode push。
const LARK_PUSH_OPTIN = im.type === 'lark' && String(im.transport || '').trim().toLowerCase() === 'push'
let IM_MODE = im.type === 'slack' ? 'push' : (LARK_PUSH_OPTIN ? 'push' : 'polling')  // 运行中可能回落为 polling
let adapter
try {
  adapter = createAdapter(profile)   // adapters/factory.js：字段校验 + 按 im.type 实例化（与 permission-bridge 共用）
} catch (err) {
  console.log(`BOT_ERROR|poll.js|${err.code || 'adapter-init'}|${err.message}`)
  process.exit(1)
}

// 多群（v0.1.51+，issue #24）：im.chat_ids 追加监听群；im.chat_id 仍是主群（上下线通知 / 权限桥 / 兜底目标）。
// 单群时一切行为与历来一致：不建游标文件、envelope 不带 CHAT 标签。
const PRIMARY_CHAT_ID = String(im.chat_id || (Array.isArray(im.chat_ids) ? im.chat_ids[0] : '') || '').trim()
const CHAT_IDS = [...new Set([PRIMARY_CHAT_ID, ...(Array.isArray(im.chat_ids) ? im.chat_ids : [])]
  .map(x => String(x || '').trim()).filter(Boolean))]
const MULTI_CHAT = CHAT_IDS.length > 1
const CHAT_ID = PRIMARY_CHAT_ID  // 旧名保留给单群路径
const ADMIN_IDS = Array.isArray(profile.members && profile.members.admin_open_ids) ? profile.members.admin_open_ids.map(String) : []
const BOT_OPEN_ID = im.bot_open_id || im.bot_user_id || ''  // lark 用 bot_open_id / slack 用 bot_user_id；未配时保守 — 任何 @ 一律 skip
const DEBUG = !!(im && im.debug)  // profile.im.debug=true 时启用 BOT_DEBUG 诊断日志
// locale 决策：profile 显式优先 → 按 IM 类型默认（lark=zh-CN / slack=en-US）→ 兜底 zh-CN
// 影响范围：bot 主动发起的系统文案（busy 占位 / 上下线通知）；不影响 LLM 跟用户对话的语言
const DEFAULT_LOCALE_BY_IM = { lark: 'zh-CN', slack: 'en-US' }
const LOCALE = im.locale || DEFAULT_LOCALE_BY_IM[im.type] || 'zh-CN'
// 默认 60s（v0.1.46+，issue #23）：飞书基础版租户级共享 1M 调用/月，10s 空转（经记忆化 1 计费/tick）
// ≈259k/月单 bot 就吃掉 1/4 租户配额；60s 降到 ≈43k/月。profile 显式设 polling_interval_ms 覆盖此默认。
// 下限 10s / 30s：配错成 100ms 会把租户配额烧光；测试用 CC_BOT_DEV_FAST=1 放开
const MIN_INTERVAL_MS = process.env.CC_BOT_DEV_FAST ? 0 : 10 * 1000
const CHECK_INTERVAL_MS = Math.max(MIN_INTERVAL_MS, Number(profile.polling_interval_ms) || 60 * 1000)
// lark push 模式的校对轮询间隔：事件流在代理 / 弱网下可能静默断流（历史坑），低频拉一次兜底，
// 每 tick 1 计费调用；默认 5min ≈ 288 calls/day（polling@60s 的 1/5）。profile.push_reconcile_interval_ms 覆盖。
const RECONCILE_INTERVAL_MS = Math.max(MIN_INTERVAL_MS * 3, Number(profile.push_reconcile_interval_ms) || 5 * 60 * 1000)
let tickIntervalMs = CHECK_INTERVAL_MS   // 当前 tick 间隔：polling=CHECK_INTERVAL_MS / lark push=RECONCILE_INTERVAL_MS
let tickTimer = null
let tickLoopStarted = false
const PAGE_SIZE = 10
// hold 期间（主会话忙 / 额度耗尽）拉更多条：hold 解除后要靠这一页把积压的消息补出来，
// 页太小时长 hold（额度耗尽可达数小时）里较早的消息会滚出拉取窗口永久丢。
// 同样是 1 次计费调用，加页不加成本（issue #23 口径）。
const HOLD_PAGE_SIZE = 30
const MAINTENANCE_INTERVAL_MS = 60 * 1000  // slack push 没有 tick 循环：额度检查 / 超时 sweep / 假死判定 合挂一个维护定时器（lark push 由校对 tick 顺带做）
// 主会话假死告警（v0.1.50+，issue #4）：判定 / 文案 / 节流全在 runtime/stall-alert.js，poll.js 只负责发 + 记账
const stall = stallAlert.createTracker({ runtimeDir: RUNTIME_DIR, profile, locale: LOCALE })
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
const MAIN_BUSY_HEARTBEAT_STALE_MS = 5 * 60 * 1000  // 5min — statusline 无更新视为会话卡死（进 degraded）
// degraded 二级阈值（issue #20）：心跳停更 ≥15min → 主会话进程真死（区别于 AskUserQuestion 阻塞 — 后者 statusline 仍更新），force-clear 锁防群消息永久漏推
const MAIN_BUSY_HEARTBEAT_DEAD_MS = 15 * 60 * 1000
const MAIN_BUSY_DEGRADED_PLACEHOLDER_INTERVAL_MS = 5 * 60 * 1000  // 5min — 降级模式占位重发间隔

// busy-held 持久化（v0.1.20，issue #9）：mainBusy 期间 held 的 msg id 落盘，下一 tick 绕过 lastTime 过滤直到 emit 成功。
// 修复 #9 静默丢消息：旧路径靠"下一 tick 时 createTimeMs > lastTime"重 emit；若 main 通过 fetch-before-reply 越过 state，
// held 消息就被 <= lastTime 过滤永久丢失。新路径用 in-memory map + JSON 文件持久化，emit 成功后才移除。
const BUSY_HELD_FILE = path.join(RUNTIME_DIR, 'poll.busy-held')
const BUSY_HELD_TTL_MS = 10 * 60 * 1000  // 10min 兜底清理（防孤儿）
const busyHeld = new Map()  // id -> { ts, chatId }

// reaction ack（v0.1.21，issue #12）：mainBusy 期间每条新消息打 emoji reaction 作为"看见了"信号。
// 仅装饰性增强 — 任何失败不影响 emit / busy-held / 文本占位。`busy_reaction: false` 完全 opt-out。
const REACTED_FILE = path.join(RUNTIME_DIR, 'poll.reacted')
const REACTED_MAX = 200
// 默认 emoji：lark='WAVE'（👋 招手）= 我看见了；slack='eyes'（👀）= 我注意到了。
// lark 合法 emoji_type 枚举见 https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/emojis-introduce
// 常用枚举：WAVE / SMILE / OK / THUMBSUP / HEART / LAUGH（'HEY' 非合法值，API 报 231001 reaction type is invalid）
const DEFAULT_REACTION_BY_IM = { lark: 'WAVE', slack: 'eyes' }
// 解析配置：
//   显式 false / 'false' → 关闭（opt-out）
//   非空字符串 → 用作 emoji key
//   undefined / null / "" → 按 IM 默认（lark='WAVE' / slack='eyes'，与 `locale` 字段同语义）
function resolveBusyReaction() {
  const v = im.busy_reaction
  if (v === false || v === 'false') return null
  if (typeof v === 'string' && v.trim()) return v.trim()
  return DEFAULT_REACTION_BY_IM[im.type] || null
}
const BUSY_REACTION = resolveBusyReaction()
const reacted = new Set()  // msg ids already reacted to this lifetime
let reactionScopeMissingLogged = false  // BOT_WARN 仅首次记一次，避免污染日志

// debug 开关（v0.1.20，issue #9 诊断）：profile.im.debug=true 时每 tick 写 BOT_DEBUG 到 events.log
// 帮排查"消息为啥没 emit"——列出 lastTime / msgs.length / 各过滤理由 / held 变化

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

// 进程内状态：上次发占位对应的 lock.ts。用于普通态 per-lock dedup（issue #7：长 lock + 持续新消息时严格 5min 周期发占位刷屏）。
// 不落盘：poll.js 重启后首条消息按"全新"处理，行为可预期；也少一个跨进程同步坑。
const lastLockTsPlaceholdered = new Map()   // chatId -> lockTs（多群各自 dedup，issue #24）
const lastPlaceholderSentAt = new Map()     // chatId -> ms（5min 节流按群计；首次回落读 flag 文件 mtime 兼容重启）

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
        atomicWriteSync(LAST_STARTUP_ERROR_FILE, JSON.stringify({
          ts: Date.now(),
          iso: new Date().toISOString(),
          reason: 'lock-taken',
          pid: process.pid,
          blocked_by_pid: Number(existing),
          message: `acquireLock 失败：poll.pid 被活进程 ${existing} 持有，本进程 ${process.pid} 退出。若确认 ${existing} 是孤儿，杀掉它并删除 poll.pid 后重启`,
        }, null, 2))
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

function logDebug(line) {
  if (!DEBUG) return
  logEvent(`BOT_DEBUG|${line}`)
}

// ========== 多群游标（v0.1.51+，issue #24）==========
//
// 单群：沿用 state.last_processed_time（主会话推进）作时间游标，行为与历来一致。
// 多群：每群独立游标 poll.cursors.json = { chatId: epochMs }，由 poll.js 在 emit 时推进。
//   不能共用全局游标：A 群新消息把游标推高后，B 群稍早但刚拉到的消息会被 `createTimeMs <= lastTime`
//   过滤永久丢（跨群交叉到达是常态，issue #24 实测丢了 3 条）。
//   新群首次出现（无游标）用全局 last_processed_time 起步避免回放历史；之后只跟自己的 emit 走，不再受全局游标影响。
const CURSORS_FILE = path.join(RUNTIME_DIR, 'poll.cursors.json')
const cursors = new Map()  // chatId -> epochMs（仅 MULTI_CHAT 使用）

function loadCursors() {
  if (!MULTI_CHAT) return
  try {
    const obj = JSON.parse(fs.readFileSync(CURSORS_FILE, 'utf8'))
    for (const [k, v] of Object.entries(obj || {})) { const n = Number(v); if (Number.isFinite(n) && n > 0) cursors.set(k, n) }
  } catch {}
  const floor = Number(readState().last_processed_time || 0)
  let dirty = false
  for (const c of CHAT_IDS) if (!cursors.has(c)) { cursors.set(c, floor); dirty = true }
  if (dirty) persistCursors()
}

function persistCursors() {
  try { atomicWriteSync(CURSORS_FILE, JSON.stringify(Object.fromEntries(cursors))) }
  catch (e) { logEvent(`BOT_WARN|poll.js|cursors-write-failed|${(e && e.message) || e}`) }
}

function cursorFor(chatId, state) {
  const global = Number(state.last_processed_time || 0)
  if (!MULTI_CHAT) return global
  const c = cursors.get(chatId)
  return Number.isFinite(c) ? c : global
}

function advanceCursor(chatId, ms) {
  if (!MULTI_CHAT || !(ms > 0)) return
  if ((cursors.get(chatId) || 0) >= ms) return
  cursors.set(chatId, ms)
  persistCursors()
}

// 权限桥待决期间，管理员的「允许 / 拒绝 <id>」是给 hook 的，不是新任务。hook 自己会把它写进 poll.emitted，
// 但 push 模式是即时 emit、polling 也有 60s tick 竞态，poll.js 侧必须也认得并先行跳过（README 承诺「不会被当新任务」）。
function readPermissionPending() {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'permission-bridge.json'), 'utf8'))
    const now = Date.now()
    return (st && Array.isArray(st.pending) ? st.pending : []).filter(p => p && p.id && Number(p.deadline || 0) > now - 60 * 1000)
  } catch { return [] }
}
function isPermissionReply(m, pending) {
  if (!pending || pending.length === 0 || !m || m.senderType !== 'user') return false
  if (!ADMIN_IDS.includes(String(m.senderId))) return false
  const sole = pending.length === 1
  return pending.some(p => !!permissionBridge.parseReply(m.content, p.id, sole))
}

// ========== busy-held 持久化 helpers（v0.1.20）==========

function loadBusyHeld() {
  try {
    const obj = JSON.parse(fs.readFileSync(BUSY_HELD_FILE, 'utf8'))
    for (const [id, entry] of Object.entries(obj || {})) {
      if (entry && typeof entry.ts === 'number') busyHeld.set(id, entry)
    }
  } catch {}
}

function persistBusyHeld() {
  try {
    atomicWriteSync(BUSY_HELD_FILE, JSON.stringify(Object.fromEntries(busyHeld)))
  } catch {}
}

function pruneBusyHeld() {
  const cutoff = Date.now() - BUSY_HELD_TTL_MS
  let pruned = 0
  for (const [id, entry] of busyHeld) {
    if (entry.ts < cutoff) {
      busyHeld.delete(id)
      pruned++
    }
  }
  if (pruned > 0) {
    logEvent(`BOT_WARN|poll.js|busy-held-pruned|${pruned} stale entries (>10min)`)
    persistBusyHeld()
  }
}

// ========== reaction ack helpers（v0.1.21，issue #12）==========

function loadReacted() {
  try {
    const lines = fs.readFileSync(REACTED_FILE, 'utf8').split('\n').filter(Boolean)
    for (const id of lines) reacted.add(id)
  } catch {}
}

function persistReacted(newId) {
  try {
    fs.appendFileSync(REACTED_FILE, newId + '\n')
    const lines = fs.readFileSync(REACTED_FILE, 'utf8').split('\n').filter(Boolean)
    if (lines.length > REACTED_MAX) {
      fs.writeFileSync(REACTED_FILE, lines.slice(-REACTED_MAX).join('\n') + '\n')
    }
  } catch {}
}

// 装饰性 — 任何失败都不应抛、不应阻塞主流程。
// 三层兜底：① BUSY_REACTION=null 直接 no-op ② 已 react 过 skip ③ adapter 返 {ok:false} BOT_WARN 不再重试
async function tryReactBusy(m) {
  if (!BUSY_REACTION) return
  if (!m || !m.id) return
  if (reacted.has(m.id)) return
  try {
    const r = await adapter.addReaction({
      messageId: m.id,
      emoji: BUSY_REACTION,
      chatId: m.chatId || PRIMARY_CHAT_ID,  // slack 需要；lark 忽略
    })
    if (r && r.ok) {
      reacted.add(m.id)
      persistReacted(m.id)
    } else if (r && r.reason && !reactionScopeMissingLogged) {
      // 仅首次失败写日志（缺 scope / 命令不支持 等典型一次性失败），避免每 tick 刷 events.log
      logEvent(`BOT_WARN|poll.js|reaction-failed|${m.id}|${r.reason}|后续不再记录此类失败本生命周期`)
      reactionScopeMissingLogged = true
    }
  } catch {
    // adapter 实现按约定不抛，但加 belt-and-suspenders 兜底
  }
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
      atomicWriteSync(STATE_FILE, JSON.stringify(fixed))
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

// NEW_MSG 已经打出去了，去重表写不进去（磁盘满 / 权限）必须留痕，否则同一条会每 tick 重发且 events.log 一片空白
function safeAppendEmitted(ids) {
  try { appendEmitted(ids) } catch (e) { logEvent(`BOT_ERROR|poll.js|emitted-write-failed|${(e && e.message) || e}|ids=${ids.join(',')}`) }
}

// 逐群拉取。单群失败就是整体失败（调用方按 consecutiveFailures 告警）；多群时某群失败只记 events.log，不影响其它群。
const chatFailStreak = new Map()  // chatId -> 连续失败次数
async function pollChat(chatId, pageSize = PAGE_SIZE) {
  try {
    const msgs = await adapter.listRecentMessages({ chatId, pageSize })
    const prev = chatFailStreak.get(chatId) || 0
    if (prev > 0 && MULTI_CHAT) logEvent(`BOT_INFO|poll.js|poll-chat-recovered|chat=${chatId}|after=${prev}`)
    chatFailStreak.set(chatId, 0)
    return msgs
  } catch (e) {
    const n = (chatFailStreak.get(chatId) || 0) + 1
    chatFailStreak.set(chatId, n)
    if (MULTI_CHAT && (n === 1 || n % 10 === 0)) logEvent(`BOT_WARN|poll.js|poll-chat-failed|chat=${chatId}|streak=${n}|${String((e && e.message) || e).slice(0, 200)}`)
    return null
  }
}

// ========== @他人消息过滤（v0.1.10）==========
// mentions 非空 + bot 不在 mention 列表 → 视为 @他人，skip emit。
// BOT_OPEN_ID 未配时保守：任何 mentions 非空都 skip（@bot 也会被忽略，等用户配 bot_open_id 才精准）。
function isAtOthers(mentions) {
  if (!Array.isArray(mentions) || mentions.length === 0) return false
  if (!BOT_OPEN_ID) return true  // 保守模式
  // 兼容两种 mention.id 形状（防 adapter 结构漂移，issue #22）：
  // lark-cli 原始为裸串 "ou_..."；slack + lark 归一后为 {open_id}。取到谁就比谁。
  return !mentions.some(mt => {
    if (!mt || !mt.id) return false
    const oid = typeof mt.id === 'string' ? mt.id : mt.id.open_id
    return oid === BOT_OPEN_ID
  })
}

// ========== bot_switch 群消息检测（issue #18，三层防御之一）==========
// 命中开关词表 → 写 tripwire（commands/stop.md + start.md pre-flight gate 读它拒绝执行）+ envelope 加 FLAGS。
// LLM 看到 FLAGS=bot_switch_from_group 应直接回拒绝模板，不调 Skill(cc-bot:stop|start)（SKILL §开关 顶部硬约束）。
function emitNewMsg(m) {
  let flags = ''
  try {
    const r = botSwitchDetect.detect(m.content)
    if (r.matched) {
      botSwitchDetect.writeTripwire(RUNTIME_DIR, {
        msg_id: m.id, sender: m.senderId, content: m.content,
        ts: Date.now(), by: r.by, keyword: r.keyword,
      })
      logEvent(`BOT_WARN|poll.js|bot-switch-from-group|msg=${m.id}|by=${r.by}|keyword=${r.keyword}|sender=${m.senderId}`)
      flags = '|FLAGS=bot_switch_from_group'
    }
  } catch {
    // 检测失败不阻 emit；最坏退到 layer 2/3 防御
  }
  // 多群时追加 CHAT 标签（主会话据此定回群 / fetch 的目标群；单群不带，envelope 与历来一致）
  const chatTag = MULTI_CHAT ? `|CHAT=${m.chatId || PRIMARY_CHAT_ID}` : ''
  console.log(`NEW_MSG|${m.id}|${m.senderId}|${m.content}|${m.createTimeMs}${flags}${chatTag}`)
  try { stall.noteEmit(m.id, m.chatId || PRIMARY_CHAT_ID) } catch {}  // 假死告警计时起点（issue #4）
}

// ========== 主会话优先级：锁检测 + 占位 ==========

function getHeartbeatAge() {
  try {
    // 钳到 ≥0 — fs 精度可导致 mtimeMs 比 Date.now() 微大产生 0.x ms 负数，与"文件缺失"的 -1 sentinel 混淆
    return Math.max(0, Date.now() - fs.statSync(HUD_STDIN_FILE).mtimeMs)
  } catch {
    return -1  // 文件不存在
  }
}

// 返回 { busy, degraded, lockTs }：
//   busy     — 主会话忙否（true 时 poll.js 不 emit 普通消息）
//   degraded — 是否进入降级模式（lock 过期 + 心跳陈旧，主会话疑似卡死如 AskUserQuestion）
//   lockTs   — 当前 lock 的 acquire ts（main-busy.js lock 时写入），用于普通态 per-lock dedup
function checkMainBusy() {
  let data
  try {
    data = JSON.parse(fs.readFileSync(MAIN_BUSY_LOCK, 'utf8'))
  } catch {
    return { busy: false, degraded: false, lockTs: 0 }
  }
  const ts = Number(data.ts || 0)
  if (Date.now() - ts > MAIN_BUSY_TTL_MS) {
    // 锁过期 → 查心跳区分「孤儿锁」vs「主会话卡死」
    const heartbeatAge = getHeartbeatAge()
    if (heartbeatAge >= 0 && heartbeatAge < MAIN_BUSY_HEARTBEAT_STALE_MS) {
      // 心跳新鲜 → 会话存活，锁是孤儿（Stop 漏 fire/unlock 失败），安全清锁恢复 emit
      logEvent(`BOT_WARN|poll.js|main-busy-lock-expired-orphan|ttl-${MAIN_BUSY_TTL_MS}ms|heartbeat-${Math.round(heartbeatAge / 1000)}s|session=${data.session || 'unknown'}`)
      try { fs.unlinkSync(MAIN_BUSY_LOCK) } catch {}
      try { fs.unlinkSync(MAIN_BUSY_NOTIFIED_FLAG) } catch {}
      return { busy: false, degraded: false, lockTs: 0 }
    }
    // 心跳陈旧/缺失 → 主会话极可能卡死（AskUserQuestion 等阻塞交互），进入降级模式
    // issue #20：再加一层 dead 阈值 — heartbeat 停更 ≥15min（或缺失且 lock 已逾期 ≥15min）→ 进程真死，force-clear 锁恢复 emit，防群消息永久漏推
    const lockExpiredFor = Date.now() - ts - MAIN_BUSY_TTL_MS
    const isDead = (heartbeatAge >= 0 && heartbeatAge >= MAIN_BUSY_HEARTBEAT_DEAD_MS) ||
                   (heartbeatAge < 0 && lockExpiredFor >= MAIN_BUSY_HEARTBEAT_DEAD_MS)
    if (isDead) {
      logEvent(`BOT_WARN|poll.js|main-busy-lock-expired-dead-cleared|ttl-${MAIN_BUSY_TTL_MS}ms|heartbeat-${heartbeatAge < 0 ? `missing-lockExpiredFor-${Math.round(lockExpiredFor / 1000)}s` : Math.round(heartbeatAge / 1000) + 's'}|session=${data.session || 'unknown'}`)
      try { fs.unlinkSync(MAIN_BUSY_LOCK) } catch {}
      try { fs.unlinkSync(MAIN_BUSY_NOTIFIED_FLAG) } catch {}
      return { busy: false, degraded: false, lockTs: 0 }
    }
    logEvent(`BOT_ERROR|poll.js|main-busy-lock-expired-degraded|ttl-${MAIN_BUSY_TTL_MS}ms|heartbeat-${heartbeatAge < 0 ? 'missing' : Math.round(heartbeatAge / 1000) + 's'}|session=${data.session || 'unknown'}`)
    return { busy: true, degraded: true, lockTs: ts }
  }
  return { busy: true, degraded: false, lockTs: ts }
}

// 占位发送策略（issue #7 引入分层语义，issue #6/#1 兼顾）：
//   ① profile.im.busy_placeholder === false → 全关 opt-out
//   ② degraded（主会话疑似卡死）→ 5min 周期心跳，避免长阻塞后期纯静默（v0.1.15 设计）
//   ③ 普通忙碌 → per-lock dedup：同一 lock acquisition 至多发 1 条
//      + 全局 5min 节流兜底，防 hook 高频 lock churn（#6 多 turn 密集）击穿 per-lock dedup
async function sendMainBusyPlaceholder({ degraded = false, lockTs = 0, chatId = PRIMARY_CHAT_ID } = {}) {
  if (profile && profile.im && profile.im.busy_placeholder === false) return

  // 上次发占位时刻：进程内按群记；进程刚起没记录时回落 flag 文件 mtime（跨重启节流，单群语义与历来一致）
  let lastSent = lastPlaceholderSentAt.get(chatId) || 0
  if (!lastSent) { try { lastSent = fs.statSync(MAIN_BUSY_NOTIFIED_FLAG).mtimeMs } catch {} }

  if (degraded) {
    if (Date.now() - lastSent < MAIN_BUSY_DEGRADED_PLACEHOLDER_INTERVAL_MS) return
  } else {
    // per-lock dedup：lockTs 相同视为同一 lock acquisition，已发过就不再发（issue #7 根治）
    if (lockTs > 0 && lockTs === lastLockTsPlaceholdered.get(chatId)) return
    // 全局节流：跨 lock 也限速 5min（issue #6 防多 turn 高频）
    if (Date.now() - lastSent < MAIN_BUSY_DEGRADED_PLACEHOLDER_INTERVAL_MS) return
    lastLockTsPlaceholdered.set(chatId, lockTs)
  }

  try {
    await adapter.sendText({ chatId, text: pickBusyPlaceholder() })
    lastPlaceholderSentAt.set(chatId, Date.now())
    fs.writeFileSync(MAIN_BUSY_NOTIFIED_FLAG, String(Date.now()))
  } catch {
    // 占位发送失败静默 — 主业务不受影响
  }
}

// ========== Claude 额度预警（v0.1.47+）==========
//
// 判定 / 文案 / 去重全在 runtime/quota-alert.js；本函数只负责「发」+「把 hold 结论交回 tick」。
// 返回 { hold }：true 时走 mainBusy 同款路径 hold 群消息，额度恢复后补推。
// holdCapable=false（push 模式）时不 hold —— 详见 startPushMode 处说明。
async function checkQuotaAndNotify({ holdCapable = true } = {}) {
  let res
  try {
    // paused 时不打扰群里（tick 已提前 return，这里是给 push 模式定时器兜底）
    if (readState().paused) return { hold: false }
    res = quotaAlert.check({ project: PROJECT_ROOT })
  } catch (e) {
    logEvent(`BOT_WARN|poll.js|quota-check-error|${(e && e.message) || e}`)
    return { hold: false }
  }
  if (!res || !res.ok) {
    logDebug(`quota|skip|${(res && res.reason) || 'unknown'}`)
    return { hold: false }
  }

  const hold = holdCapable && !!res.hold
  if (res.shouldNotify && res.text) {
    // 耗尽档的文案要跟真实 hold 能力一致，别承诺做不到的「我先记着」
    const text = res.level === 'exhausted' && !hold
      ? quotaAlert.render({ ...res, hold: false })
      : res.text
    // 额度是全局的，每个群都要知道；任一群发成功就记账（失败的群下 tick 不再补 —— 宁可少发一群也别刷屏）
    let sentAny = false
    for (const c of CHAT_IDS) {
      try { await adapter.sendText({ chatId: c, text }); sentAny = true }
      catch (e) { logEvent(`BOT_WARN|poll.js|quota-alert-send-failed|${res.level}|chat=${c}|${(e && e.message) || e}`) }
    }
    if (sentAny) {
      // 发成功才记账；失败不记 → 下一 tick 自动重试（不会永久漏报）
      quotaAlert.record({ project: PROJECT_ROOT, level: res.level })
      logEvent(`BOT_INFO|poll.js|quota-alert|${res.level}|used=${Math.round(res.used)}%|resets=${res.resetsAt}`)
    }
  }
  logDebug(`quota|used=${Math.round(res.used)}%|level=${res.level || 'none'}|hold=${hold}`)
  return { hold }
}

// ========== 主会话假死告警（v0.1.50+，issue #4）==========
//
// 判定 / 文案 / 节流在 runtime/stall-alert.js；本函数只负责「发」+「记账」。
// 发成功才 commit；失败不记 → 下一 tick 重判重发。告警同时打到 stdout（终端 Monitor 可见）+ events.log，
// 回应 issue #4「假死时群里和终端均无信号」。
async function runStallCheck({ mainBusy = false, botMsgMaxTime = 0 } = {}) {
  if (!stall.enabled) return
  let d
  try {
    d = stall.check({ mainBusy, botMsgMaxTime })
  } catch (e) {
    logEvent(`BOT_WARN|poll.js|stall-check-error|${(e && e.message) || e}`)
    return
  }
  if (!d) return
  if (d.action === 'none') { if (d.log) logEvent(d.log); return }
  try {
    await adapter.sendText({ chatId: d.chatId || PRIMARY_CHAT_ID, text: d.text })
    stall.commit(d)
    logEvent(d.log)
    if (d.action === 'alert') console.log(d.log)
  } catch (e) {
    logEvent(`BOT_WARN|poll.js|stall-alert-send-failed|${d.action}|${(e && e.message) || e}`)
  }
}

async function tick() {
  if (!checkStdoutTolerance()) return
  verifyLock()

  let state = readState()
  state = guardFutureTime(state)

  if (state.paused) return

  // v0.1.37+ 长任务 sweep — 内部按 profile.dispatch.max_turn_time_mins 决定是否真扫；
  // 默认 0=不启用直接返回，无开销。inline 调用避开 spawn node 进程的成本，try 兜住任何异常。
  runSweep()

  pruneBusyHeld()
  const { busy: mainBusy, degraded, lockTs } = checkMainBusy()
  // 额度耗尽与主会话忙碌走同一条 hold 路径：不 emit、进 busy-held、恢复后补推
  // hold 能力只有纯 polling 才有（下一 tick 能重 fetch）；push 模式推来的消息不 emit 即永久丢
  const { hold: quotaHold } = await checkQuotaAndNotify({ holdCapable: IM_MODE === 'polling' })
  const holdMsgs = mainBusy || quotaHold
  // hold 中、或 hold 刚结束还有 held 没补发 → 都用大页：否则 hold 结束第一 tick 回到 10 条，
  // 较早的 held 消息滚出窗口，只能等 10min TTL 被 prune 掉 —— issue #9 那种静默丢失
  const pageSize = (holdMsgs || busyHeld.size > 0) ? HOLD_PAGE_SIZE : PAGE_SIZE

  // 逐群拉取（v0.1.51+ 多群，issue #24）；单群就是一轮
  const batches = []
  for (const chatId of CHAT_IDS) {
    const msgs = await pollChat(chatId, pageSize)
    if (msgs !== null) batches.push({ chatId, msgs })
  }
  if (batches.length === 0) {
    consecutiveFailures++
    if (consecutiveFailures >= FAIL_ALERT_THRESHOLD && !alertedOnce) {
      console.log(`BOT_ERROR|poll.js|adapter 连续失败 ${consecutiveFailures} 次，可能认证过期或网络故障`)
      alertedOnce = true
    }
    await runStallCheck({ mainBusy })  // 拉取失败不影响本地信号判定
    return
  }
  consecutiveFailures = 0
  alertedOnce = false

  const emitted = readEmitted()
  const pendingPerm = readPermissionPending()
  const newlyEmitted = []
  const busySeenChats = new Set()
  let busyHeldDirty = false
  let botMsgMaxTime = 0  // 本 tick 看到的 bot 自己发言的最大 createTimeMs（假死告警的「已接手」信号之一）
  let total = 0
  // 过滤理由分布（debug 用）
  const reasons = { id: 0, emitted: 0, bot: 0, type: 0, time: 0, atOthers: 0, permReply: 0, held: 0, emitNow: 0, lateRelease: 0 }

  for (const { chatId, msgs } of batches) {
    total += msgs.length
    if (msgs.length === 0) continue
    const lastTime = cursorFor(chatId, state)
    let maxDoneCt = 0  // 本群本 tick 已处理（emit / 视为已处理）的最大 createTimeMs → 多群游标推进值
    const done = (m) => { if (m.createTimeMs > maxDoneCt) maxDoneCt = m.createTimeMs }
    // adapter 返回降序，翻成升序处理
    const asc = [...msgs].reverse()

    for (const m of asc) {
      if (!m.id) { reasons.id++; continue }
      if (!m.chatId) m.chatId = chatId
      if (emitted.has(m.id)) {
        reasons.emitted++
        // 已被别的路径消费（push 先到 / permission-bridge 吃掉管理员回复）→ 不必再 hold
        if (busyHeld.has(m.id)) { busyHeld.delete(m.id); busyHeldDirty = true }
        continue
      }
      if (m.senderType === 'bot') {
        reasons.bot++
        if (m.createTimeMs > botMsgMaxTime) botMsgMaxTime = m.createTimeMs
        continue
      }
      if (!VALID_TYPES.has(m.type)) { reasons.type++; continue }

      // busy-held：在 hold 列表里的消息绕过 lastTime 过滤（issue #9）
      const isHeld = busyHeld.has(m.id)
      if (!isHeld && (!m.createTimeMs || m.createTimeMs <= lastTime)) { reasons.time++; continue }

      // @他人过滤：视为已处理（append emitted），下次不再扫
      if (isAtOthers(m.mentions)) {
        reasons.atOthers++
        newlyEmitted.push(m.id); done(m)
        if (isHeld) { busyHeld.delete(m.id); busyHeldDirty = true }
        continue
      }
      // 权限桥待决中的管理员回复：是给 hook 的，不当新任务
      if (isPermissionReply(m, pendingPerm)) {
        reasons.permReply++
        newlyEmitted.push(m.id); done(m)
        if (isHeld) { busyHeld.delete(m.id); busyHeldDirty = true }
        continue
      }

      if (holdMsgs) {
        // 主窗口忙 / 额度耗尽：不 emit、不记 emitted；记 busy-held（持久化，下次绕过 time 过滤直到 emit 成功）
        busySeenChats.add(chatId)
        if (!isHeld) {
          busyHeld.set(m.id, { ts: Date.now(), chatId })
          busyHeldDirty = true
          reasons.held++
          // reaction ack — 装饰性，失败不影响 hold/emit 链路（issue #12）
          await tryReactBusy(m)
        }
        continue
      }

      // busy 已退出 + 该消息曾被 held：emit 之；若 createTime < lastTime 说明 main 通过 fetch-before-reply 越过了 state，
      // 重新 emit 可能导致主会话重复回复 — 写 BOT_WARN 让运维可见（main 端 SOP 应做 dedup，见 SKILL）
      if (isHeld && m.createTimeMs <= lastTime) {
        logEvent(`BOT_WARN|poll.js|busy-held-late-release|msg=${m.id}|ct=${m.createTimeMs}|lastTime=${lastTime}|main 可能已 fetch 处理过；重新 emit，需主会话端 dedup`)
        reasons.lateRelease++
      }

      emitNewMsg(m)
      newlyEmitted.push(m.id); done(m)
      reasons.emitNow++
      if (isHeld) { busyHeld.delete(m.id); busyHeldDirty = true }
    }
    advanceCursor(chatId, maxDoneCt)
  }

  if (busyHeldDirty) persistBusyHeld()
  if (mainBusy) for (const c of busySeenChats) await sendMainBusyPlaceholder({ degraded, lockTs, chatId: c })
  if (newlyEmitted.length > 0) safeAppendEmitted(newlyEmitted)
  logDebug(`tick|chats=${batches.length}/${CHAT_IDS.length}|lastTime=${state.last_processed_time}|msgs=${total}|busy=${mainBusy}|quotaHold=${quotaHold}|held=${busyHeld.size}|reasons=${JSON.stringify(reasons)}`)
  await runStallCheck({ mainBusy, botMsgMaxTime })
}

// dispatch 超时回收（v0.1.37+）：polling tick 与 slack 维护定时器共用
function runSweep() {
  try {
    const sweepRes = dispatchModule.sweep({ project: PROJECT_ROOT })
    if (sweepRes && sweepRes.swept > 0) {
      logEvent(`BOT_WARN|poll.js|sweep|超时回收 ${sweepRes.swept} 个 worker：${(sweepRes.swept_ids || []).join(',')}${sweepRes.promoted ? `|promoted:${sweepRes.promoted}` : ''}`)
    }
  } catch (e) {
    logEvent(`BOT_WARN|poll.js|sweep-error|${e.message}`)
  }
}

// 复用 tick 的过滤/去重逻辑，但不做 mainBusy/EPIPE/lock/常驻（单次执行不需要）。
async function pollOnce() {
  let state = readState()
  state = guardFutureTime(state)
  if (state.paused) return
  loadCursors()
  const emitted = readEmitted()
  const pendingPerm = readPermissionPending()
  const newlyEmitted = []
  let okChats = 0
  for (const chatId of CHAT_IDS) {
    const msgs = await pollChat(chatId, PAGE_SIZE)
    if (msgs === null) continue
    okChats++
    const lastTime = cursorFor(chatId, state)
    let maxDoneCt = 0
    for (const m of [...msgs].reverse()) {
      if (!m.id) continue
      if (!m.chatId) m.chatId = chatId
      if (emitted.has(m.id)) continue
      if (m.senderType === 'bot') continue
      if (!VALID_TYPES.has(m.type)) continue
      if (!m.createTimeMs || m.createTimeMs <= lastTime) continue
      if (isAtOthers(m.mentions) || isPermissionReply(m, pendingPerm)) {
        newlyEmitted.push(m.id); if (m.createTimeMs > maxDoneCt) maxDoneCt = m.createTimeMs
        continue
      }
      emitNewMsg(m)
      newlyEmitted.push(m.id); if (m.createTimeMs > maxDoneCt) maxDoneCt = m.createTimeMs
    }
    advanceCursor(chatId, maxDoneCt)
  }
  if (okChats === 0) {
    console.log(`BOT_ERROR|poll.js|once|adapter 拉取失败（认证过期或网络故障）`)
    process.exitCode = 1
    return
  }
  if (newlyEmitted.length > 0) safeAppendEmitted(newlyEmitted)
}

// ========== 启动 ==========

const ONCE_MODE = process.argv.includes('--once')  // self-poll：跑一次输出后退出

function scheduleTick() {
  tickLoopStarted = true
  tick().finally(() => { tickTimer = setTimeout(scheduleTick, tickIntervalMs) })
}

// lark push → polling 回落（启动失败 / 断流不可恢复）。幂等；回落后本进程生命周期内不再尝试 push。
function fallbackToPolling(reason) {
  if (IM_MODE === 'polling') return
  IM_MODE = 'polling'
  tickIntervalMs = CHECK_INTERVAL_MS
  try { if (typeof adapter.stopListeningSync === 'function') adapter.stopListeningSync() } catch {}
  const why = String(reason || '').replace(/[\r\n]+/g, ' ').slice(0, 400)
  logEvent(`BOT_WARN|poll.js|push-fallback-polling|${why}`)
  console.log(`BOT_INFO|poll.js|push-fallback|lark 事件长连接不可用，已回落 HTTP polling @ ${Math.round(CHECK_INTERVAL_MS / 1000)}s（${why}）`)
  if (tickTimer) clearTimeout(tickTimer)
  tickTimer = setTimeout(scheduleTick, 1000)
}

// Push 模式（slack / lark push）：单条到达，复用 tick 内部的过滤/emit 逻辑
async function handlePushMessage(m) {
  if (!checkStdoutTolerance()) return
  verifyLock()

  let state = readState()
  state = guardFutureTime(state)
  if (state.paused) return

  if (!m || !m.id) return
  if (!m.chatId) m.chatId = PRIMARY_CHAT_ID  // 老 adapter 不带 chat → 视为主群
  if (MULTI_CHAT && !CHAT_IDS.includes(m.chatId)) return  // adapter 已按集合过滤，这里双保险

  const { busy: mainBusy, degraded, lockTs } = checkMainBusy()
  const lastTime = cursorFor(m.chatId, state)
  const emitted = readEmitted()

  if (emitted.has(m.id)) return
  if (m.senderType === 'bot') return
  if (!VALID_TYPES.has(m.type)) return
  if (!m.createTimeMs || m.createTimeMs <= lastTime) return

  if (isAtOthers(m.mentions) || isPermissionReply(m, readPermissionPending())) {
    safeAppendEmitted([m.id])
    advanceCursor(m.chatId, m.createTimeMs)
    return
  }

  if (mainBusy) {
    // push 模式必须立刻 emit — 没有"下一 tick 重新 fetch"机制，错过 push 永久丢失
    // （lark push 虽有校对轮询，但间隔 5min 且只是兜底，不拿它当主路径）。
    // 主会话忙时 CC 会自动把 notification 排队，忙完按顺序处理 → 消息不丢 + 不打断主会话节奏。
    // busy 占位由 sendMainBusyPlaceholder 内部做 per-lock + 全局节流去重，不会刷屏。
    emitNewMsg(m)
    safeAppendEmitted([m.id])
    advanceCursor(m.chatId, m.createTimeMs)
    // reaction ack — 装饰性，与 emit/占位并列，失败不影响主链路（issue #12）
    await tryReactBusy(m)
    await sendMainBusyPlaceholder({ degraded, lockTs, chatId: m.chatId })
    return
  }

  emitNewMsg(m)
  safeAppendEmitted([m.id])
  advanceCursor(m.chatId, m.createTimeMs)
}

// 首连也给重试预算：/cc-bot:start 时一次网络抖动（30s 内没 ready）不该让这一整个进程生命周期都失去免配额传输
let pushStartAttempts = 0
const PUSH_START_MAX_ATTEMPTS = 3
const PUSH_START_RETRY_MS = 10 * 1000

async function startPushMode() {
  pushStartAttempts++
  try {
    await adapter.startListening({
      chatId: PRIMARY_CHAT_ID,
      chatIds: CHAT_IDS,
      onMessage: (m) => {
        handlePushMessage(m).catch(err => {
          console.log(`BOT_ERROR|poll.js|push-handler|${err.message}`)
        })
      },
      onError: (err) => {
        const msg = (err && err.message) || String(err)
        if (err && err.warn) { logEvent(`BOT_WARN|poll.js|push-event-dropped|${msg}`); return }
        // lark push：adapter 自己退避重连；fatal（环境不满足 / 重连耗尽）才回落 polling
        if (LARK_PUSH_OPTIN && err && err.fatal) { fallbackToPolling(msg); return }
        if (err && err.transient) { logEvent(`BOT_WARN|poll.js|push-stream-transient|${msg}`); return }
        console.log(`BOT_ERROR|poll.js|push-stream|${msg}`)
      },
    })
    console.log(`BOT_INFO|poll.js|push-listening|${im.type}|${CHAT_IDS.join(',')}`)
    if (LARK_PUSH_OPTIN) {
      // 校对轮询：低频 tick 复用 polling 全套过滤 / 去重 / 额度检查，补事件流漏掉的消息。
      // 第一次 5s 后就跑：把 bot 离线期间 / 连接建立前到达的消息尽快补出来，之后按 RECONCILE_INTERVAL_MS。
      tickIntervalMs = RECONCILE_INTERVAL_MS
      if (!tickLoopStarted) { tickLoopStarted = true; tickTimer = setTimeout(scheduleTick, 5000) }
    }
  } catch (err) {
    const msg = (err && err.message) || String(err)
    if (LARK_PUSH_OPTIN) {
      if (!(err && err.fatal) && pushStartAttempts < PUSH_START_MAX_ATTEMPTS) {
        logEvent(`BOT_WARN|poll.js|push-start-retry|attempt=${pushStartAttempts}|${msg}`)
        setTimeout(startPushMode, PUSH_START_RETRY_MS)
        return
      }
      fallbackToPolling(msg)
      return
    }
    console.log(`BOT_ERROR|poll.js|push-start|${msg}`)
    process.exit(1)
  }
}

if (ONCE_MODE) {
  // self-poll 单次模式：不取锁、不常驻，跑一次输出新消息后退出（由 /loop 每轮驱动）
  pollOnce()
    .then(() => process.exit(process.exitCode || 0))
    .catch((err) => { console.log(`BOT_ERROR|poll.js|once|${(err && err.message) || err}`); process.exit(1) })
} else {
  // 常驻模式（Monitor 托管）
  acquireLock()
  loadBusyHeld()  // v0.1.20：恢复上次未 emit 的 held 消息（issue #9）
  loadReacted()   // v0.1.21：恢复上次已打 reaction 的 msg id 集合（issue #12，防重打）
  loadCursors()   // v0.1.51：多群各自游标（单群 no-op）
  // 退出前顺手关事件长连接子进程（lark push）：关 stdin = lark-cli 的优雅退出信号，走退订不留孤儿
  const shutdownAdapter = () => { try { if (typeof adapter.stopListeningSync === 'function') adapter.stopListeningSync() } catch {} }
  process.on('exit', () => { shutdownAdapter(); releaseLock() })
  process.on('SIGINT', () => { shutdownAdapter(); releaseLock(); process.exit(0) })
  process.on('SIGTERM', () => { shutdownAdapter(); releaseLock(); process.exit(0) })
  // 不退出但要留痕：没有这两行 events.log 对任何 tick 内的异常都是一片空白
  process.on('uncaughtException', (e) => { logEvent(`BOT_ERROR|poll.js|uncaught|${String((e && e.stack) || e).slice(0, 1200)}`) })
  process.on('unhandledRejection', (e) => { logEvent(`BOT_ERROR|poll.js|unhandled-rejection|${String((e && e.stack) || e).slice(0, 1200)}`) })
  if (MULTI_CHAT) {
    console.log(`BOT_INFO|poll.js|multi-chat|监听 ${CHAT_IDS.length} 个群：${CHAT_IDS.join(', ')}（主群 ${PRIMARY_CHAT_ID}；各群独立游标 poll.cursors.json；NEW_MSG 末尾带 CHAT=<群>）`)
  }
  // issue #23：启动打印配额成本预测，让 polling 的租户 API 消耗前置可见。
  // 飞书基础版租户级共享 1M 调用/月，polling 计费、事件订阅不计费。
  // lark 空转经 epoch 记忆化后 ≈ 1 计费/tick/群；活跃 tick 遇新消息再 +1 raw 调用。
  const nChats = CHAT_IDS.length
  const perChat = nChats > 1 ? ` × ${nChats} 群` : ''
  if (IM_MODE === 'polling') {
    const ticksPerDay = Math.round((86400 * 1000) / CHECK_INTERVAL_MS) * nChats
    console.log(`BOT_INFO|poll.js|quota-projection|${im.type} polling @ ${Math.round(CHECK_INTERVAL_MS / 1000)}s${perChat}：空转≈${ticksPerDay} calls/day ≈${Math.round(ticksPerDay * 30 / 1000)}k/month（租户级共享配额；活跃遇新消息 tick +1）`)
  } else if (LARK_PUSH_OPTIN) {
    const reconcilesPerDay = Math.round((86400 * 1000) / RECONCILE_INTERVAL_MS) * nChats
    console.log(`BOT_INFO|poll.js|quota-projection|lark push（事件长连接，不计配额）+ 校对轮询 @ ${Math.round(RECONCILE_INTERVAL_MS / 1000)}s${perChat}：空转≈${reconcilesPerDay} calls/day；长连接不可用自动回落 polling @ ${Math.round(CHECK_INTERVAL_MS / 1000)}s`)
  }
  if (stall.enabled) {
    console.log(`BOT_INFO|poll.js|stall-alert|主会话假死告警已开：emit 后 ${Math.round(stall.cfg.stallMs / 6000) / 10}min 内 HUD 心跳 / agents.json / 群内 bot 发言都无动静 → 发群 + 终端 BOT_WARN；mainBusy 期间不判，同一次每 30min 最多再提醒一次`)
  }
  if (IM_MODE === 'push') {
    setTimeout(startPushMode, 1000)
    if (!LARK_PUSH_OPTIN) {
      // slack push 没有 tick 循环：额度检查 / 超时 sweep / 假死判定 合挂一个 60s 维护定时器（lark push 由校对 tick 顺带做）。
      // 额度 holdCapable=false：Socket Mode 推来的消息不 emit 就永久丢，没有「下一 tick 重 fetch」兜底，
      // 所以耗尽期仍照常 emit（CC 会把 notification 排队），只是话术改成「恢复后麻烦重发」。
      setInterval(() => {
        if (readState().paused) return
        checkQuotaAndNotify({ holdCapable: false }).catch(() => {})
        runSweep()
        if (stall.enabled) runStallCheck({ mainBusy: checkMainBusy().busy }).catch(() => {})
      }, MAINTENANCE_INTERVAL_MS)
    }
  } else {
    tickTimer = setTimeout(scheduleTick, 1000)
  }
}
