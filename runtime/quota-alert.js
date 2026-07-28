#!/usr/bin/env node
// cc-bot Claude 额度预警 —— 5h rate limit 快满时主动告知群里（v0.1.47+）
//
// 群成员看不到 CC 终端，额度耗尽时只体验到「bot 突然不说话」，会误判成 bot 挂了。
//
// 为什么判定放 poll.js：它是独立 node 进程，**不消耗 Claude 额度** —— 额度耗尽时它恰恰是
// 唯一还能开口的组件。（也不能放 statusline.js：那在 CC 状态栏关键路径上，发 IM 会拖慢状态栏。）
//
// 数据源 hud-stdin.json：`rate_limits.five_hour = { used_percentage, resets_at }`，resets_at 是
// **Unix 秒**。当前 % 和恢复时刻都是现成的，零历史零推算。
//
// 两道免费门禁：① HUD mtime > 15min = 陈旧跳过（HUD 陈旧 ≈ 主会话闲着 ≈ 额度没在烧，
// 「该报的时候数据一定新」）② resets_at 已过去 = 上个窗口残留，挡主会话重启 / 切账号的误报。
//
// 去重：resets_at 当窗口键存 quota-notified.json，窗口一滚 sent 自动清零 —— 自带自愈无需 TTL。
//
// ⚠ 只读 rate_limits。hud-stdin.json 里的 cost.total_cost_usd 绝不能进群（SKILL「禁止展示 cost」）。
//
// CLI：
//   quota-alert.js check  --project <root>   # 评估（含窗口滚动落盘）
//   quota-alert.js status --project <root>   # 只读诊断，不写 state（doctor 用）

const fs = require('fs')
const path = require('path')
const { atomicWriteSync } = require('./atomic-write')

const HUD_STALE_MS = 15 * 60 * 1000
const EXHAUSTED_AT = 100
const DEFAULT_WARN_AT = 85
const DEFAULT_URGENT_AT = 95

// 档位只升不降 —— 0 直接跳到 97% 时只发 urgent，不补发 warn
const RANK = { warn: 1, urgent: 2, exhausted: 3 }

const DEFAULT_LOCALE_BY_IM = { lark: 'zh-CN', slack: 'en-US' }

// ========== 路径 / IO ==========

function paths(projectRoot) {
  const ccb = path.join(projectRoot, '.cc-bot')
  const rt = path.join(ccb, 'runtime')
  return {
    profile: path.join(ccb, 'profiles', 'active.json'),
    hud: path.join(rt, 'hud-stdin.json'),
    state: path.join(rt, 'quota-notified.json'),
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeState(file, obj) {
  // 落盘失败 = 下一 tick 重判；最坏重复发一条，不影响主链路
  try { atomicWriteSync(file, JSON.stringify(obj)) } catch {}
}

// ========== 配置 ==========

function numOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback
}

// 缺字段一律走默认（老 profile 没跑过 profile-migrate 也能工作）
function resolveConfig(profile) {
  const qa = (profile && profile.quota_alert) || {}
  const fh = qa.five_hour || {}
  const warnAt = numOr(fh.warn_at, DEFAULT_WARN_AT)
  const urgentAt = numOr(fh.urgent_at, DEFAULT_URGENT_AT)
  return {
    enabled: qa.enabled !== false,
    // 配反了（warn > urgent）按大小归位，避免 urgent 永远触发不到
    warnAt: Math.min(warnAt, urgentAt),
    urgentAt: Math.max(warnAt, urgentAt),
    notifyRecovered: qa.notify_recovered !== false,
    hold: qa.hold_messages_when_exhausted !== false,
  }
}

// 与 poll.js 同规则：profile 显式优先 → 按 IM 类型默认 → 兜底 zh-CN
function resolveLocale(profile) {
  const im = (profile && profile.im) || {}
  return im.locale || DEFAULT_LOCALE_BY_IM[im.type] || 'zh-CN'
}

// ========== 文案（≤2 行，群里不看长文）==========

// 群里的时间一律北京时区（SKILL §规则 1b）。手算 UTC+8 不用 Intl —— 不依赖运行环境 ICU，跨平台结果确定。
function beijingHHMM(epochSec) {
  return new Date((epochSec + 8 * 3600) * 1000).toISOString().slice(11, 16)
}

function remainText(ms) {
  if (ms >= 3600 * 1000) return `${(ms / 3600000).toFixed(1)}h`
  return `${Math.max(1, Math.round(ms / 60000))}min`
}

// 符号沿用 cc-bot 单色几何族（● 上线 / ○ 下线 / ✓ 完成 / ✕ 失败），本模块扩两个：
//   ◐ 半满 = 额度预警   ◌ 虚空 = 额度耗尽
function render({ level, used, resetsAt, resetsInMs, locale, hold }) {
  const en = locale === 'en-US'
  const hhmm = beijingHHMM(resetsAt)
  const left = remainText(resetsInMs)

  if (level === 'recovered') return en ? '● Limit restored' : '● 额度已恢复'

  if (level === 'exhausted') {
    // hold 关掉（或 push 模式）时消息真的可能没人接，不能承诺做不到的「我先记着」
    const tail = hold
      ? (en ? "Messages held, I'll pick them up after" : '这期间的消息我先记着，恢复后一起处理')
      : (en ? 'Replies may not come — please resend after' : '消息可能没回应，恢复后麻烦重发')
    return en
      ? `◌ 5h limit reached · back ${hhmm} CST (${left})\n${tail}`
      : `◌ 5h 额度用完了，${hhmm} 恢复（还有 ${left}）\n${tail}`
  }

  const pct = Math.round(used)
  const tail = level === 'urgent'
    ? (en ? 'Short questions only' : '只接短问题，大任务等重置后')
    : (en ? 'Big tasks are better after reset' : '大任务建议等重置后提')
  return en
    ? `◐ 5h limit ${pct}% · resets ${hhmm} CST (${left})\n${tail}`
    : `◐ 5h 额度 ${pct}%，${hhmm} 重置（还有 ${left}）\n${tail}`
}

// ========== 核心判定 ==========

// 返回：
//   { ok:false, reason }                                  — 不判定（关闭 / HUD 缺失或陈旧 / 数据无效）
//   { ok:true, level, shouldNotify, text, exhausted, hold, used, resetsAt, ... }
//
// exhausted / hold 与 shouldNotify 无关，每 tick 都返真实值 —— 通知只发一次，但 hold 要覆盖整个耗尽期。
// dryRun=true 不写任何 state（doctor 只读健康检查用）。
function check({ project, dryRun = false, now = Date.now() }) {
  if (!project) return { ok: false, reason: 'no-project' }
  const p = paths(project)

  const profile = readJson(p.profile)
  if (!profile) return { ok: false, reason: 'profile-missing' }
  const cfg = resolveConfig(profile)
  if (!cfg.enabled) return { ok: false, reason: 'disabled' }
  const locale = resolveLocale(profile)

  // 门禁 ①：HUD 新鲜度
  let ageMs
  try {
    ageMs = Math.max(0, now - fs.statSync(p.hud).mtimeMs)
  } catch {
    return { ok: false, reason: 'hud-missing' }
  }
  if (ageMs > HUD_STALE_MS) {
    // 例外：上次已知「耗尽」且该窗口还没到重置点 → 继续 hold。
    // 额度一用完用户多半就离开终端，statusline 随即停更 —— 此时按「陈旧就放行」处理，
    // 会在剩下的几小时里把群消息 emit 给一个没额度回应的主会话（= 正是本功能要防的丢失）。
    // 陈旧 ≠ 恢复；靠落盘的 resets_at 兜到重置点自动失效，不会永久 hold。
    const prev = (readJson(p.state) || {}).five_hour
    if (prev && Array.isArray(prev.sent) && prev.sent.includes('exhausted') &&
        typeof prev.resets_at === 'number' && prev.resets_at * 1000 > now) {
      return {
        ok: true, reason: 'hud-stale-holding', level: null, shouldNotify: false, text: null,
        used: EXHAUSTED_AT, resetsAt: prev.resets_at, resetsInMs: prev.resets_at * 1000 - now,
        locale, exhausted: true, hold: cfg.hold, config: cfg, sent: prev.sent,
      }
    }
    return { ok: false, reason: 'hud-stale', ageMs }
  }

  const hud = readJson(p.hud)
  const rl = hud && hud.rate_limits && hud.rate_limits.five_hour
  if (!rl || typeof rl.used_percentage !== 'number' || typeof rl.resets_at !== 'number') {
    return { ok: false, reason: 'no-rate-limits' }
  }
  const used = rl.used_percentage
  const resetsAt = rl.resets_at
  const resetsInMs = resetsAt * 1000 - now

  // 门禁 ②：resets_at 已过去 = 上个窗口的残留数据
  if (resetsInMs <= 0) return { ok: false, reason: 'window-expired', resetsAt }

  // 窗口滚动：resets_at 变了 = 新窗口，sent 清零；上窗口发过 urgent/耗尽 → 挂 pending_recovered
  const st = readJson(p.state) || {}
  let fh = (st.five_hour && typeof st.five_hour === 'object') ? st.five_hour : null
  if (!fh || fh.resets_at !== resetsAt) {
    const prevSent = (fh && Array.isArray(fh.sent)) ? fh.sent : []
    const wasSevere = prevSent.includes('urgent') || prevSent.includes('exhausted')
    fh = { resets_at: resetsAt, sent: [], pending_recovered: !!(cfg.notifyRecovered && wasSevere) }
    // 窗口滚动是既成事实（与发送成功与否无关），立即落盘
    if (!dryRun) writeState(p.state, { ...st, five_hour: fh })
  }

  const exhausted = used >= EXHAUSTED_AT
  const base = { ok: true, used, resetsAt, resetsInMs, locale, exhausted, hold: cfg.hold && exhausted, config: cfg }

  // 恢复通知优先：本 tick 只发「已恢复」，新窗口若已越阈值下一 tick（≤60s）自然接上，
  // 避免「已恢复」和「85%」贴脸连发两条
  if (fh.pending_recovered) {
    return { ...base, level: 'recovered', shouldNotify: true, text: render({ ...base, level: 'recovered' }) }
  }

  let level = null
  if (exhausted) level = 'exhausted'
  else if (used >= cfg.urgentAt) level = 'urgent'
  else if (used >= cfg.warnAt) level = 'warn'

  const sent = Array.isArray(fh.sent) ? fh.sent : []
  const maxSentRank = sent.reduce((m, s) => Math.max(m, RANK[s] || 0), 0)
  const shouldNotify = !!level && RANK[level] > maxSentRank

  return { ...base, level, shouldNotify, text: shouldNotify ? render({ ...base, level }) : null, sent }
}

// 发送成功后调用：记下这一档（连同所有更低档，防回落时补发低档）。
// 发送失败**不要**调 —— 下一 tick 会重试。
function record({ project, level, now = Date.now() }) {
  if (!project || !level) return { ok: false }
  const p = paths(project)
  const st = readJson(p.state) || {}
  const fh = (st.five_hour && typeof st.five_hour === 'object') ? st.five_hour : { sent: [] }

  if (level === 'recovered') {
    fh.pending_recovered = false
  } else {
    const rank = RANK[level] || 0
    const sent = new Set(Array.isArray(fh.sent) ? fh.sent : [])
    for (const [name, r] of Object.entries(RANK)) if (r <= rank) sent.add(name)
    fh.sent = [...sent]
  }
  fh.last_notified_at = now

  writeState(p.state, { ...st, five_hour: fh })
  return { ok: true, sent: fh.sent || [], pending_recovered: !!fh.pending_recovered }
}

// ========== CLI ==========

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i++
    }
  }
  return args
}

function usage() {
  return [
    'Usage:',
    '  quota-alert.js check  --project <root>   # 评估 5h 额度（含窗口滚动落盘）',
    '  quota-alert.js status --project <root>   # 只读诊断，不写 state（doctor 用）',
    '',
    'Output:',
    '  {"ok":true,"level":"warn|urgent|exhausted|recovered|null","shouldNotify":bool,',
    '   "exhausted":bool,"hold":bool,"used":85.2,"resetsAt":1785237600,"text":"..."}',
    '  {"ok":false,"reason":"disabled|hud-missing|hud-stale|no-rate-limits|window-expired|profile-missing"}',
    '',
    '阈值 / 开关见 profile.quota_alert（缺省 enabled=true, warn_at=85, urgent_at=95）。',
  ].join('\n')
}

function main() {
  const [, , subcmd, ...rest] = process.argv
  if (!subcmd || subcmd === '--help' || subcmd === '-h') {
    process.stdout.write(usage() + '\n')
    process.exit(0)
  }
  const args = parseArgs(rest)
  try {
    if (!args.project) throw new Error('--project required')
    if (subcmd === 'check' || subcmd === 'status') {
      process.stdout.write(JSON.stringify(check({ project: args.project, dryRun: subcmd === 'status' })) + '\n')
    } else if (subcmd === 'record') {
      process.stdout.write(JSON.stringify(record({ project: args.project, level: args.level })) + '\n')
    } else {
      process.stderr.write(`unknown subcommand: ${subcmd}\n${usage()}\n`)
      process.exit(2)
    }
  } catch (e) {
    process.stderr.write(`ERROR: ${(e && e.message) || e}\n`)
    process.exit(1)
  }
}

if (require.main === module) main()

module.exports = {
  check, record, render, beijingHHMM, remainText,
  resolveConfig, resolveLocale,
  HUD_STALE_MS, EXHAUSTED_AT, DEFAULT_WARN_AT, DEFAULT_URGENT_AT, RANK,
}
