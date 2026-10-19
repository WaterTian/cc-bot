#!/usr/bin/env node
// cc-bot 权限桥 — CC `PermissionRequest` hook：把主会话的权限弹窗转发到 IM 群（issue #10 / #17）。
//
// 场景：bot 在群里接了任务，主会话跑到一个不在 allow 列表里的工具 → CC 弹「允许 / 拒绝」等终端边的人。
// 开 bot 本来就是为了人不在终端边也能协作，于是弹窗一卡，群里只看到 bot 突然沉默。
//
// 两档（profile.permission_bridge.mode）：
//   notify  — 单向：群里发一条「🔐 需要授权」提示即退出；终端弹窗照常等人（issue #17）
//   approve — 双向：发提示后在 wait_secs 内轮询群消息，管理员回「允许 <id>」/「拒绝 <id>」即代答 CC；
//             无人回应 → exit 0 且不输出 decision，权限流程原样继续（终端弹窗仍在）= fail-closed（issue #10）
//
// 默认全关（profile.permission_bridge.enabled=false）。hook 注册在 ~/.claude/settings.json 全局，
// 非 cc-bot 项目 / 未启用 / bot 已 paused → 立即静默 exit 0，零副作用（与 main-busy.js 同策略）。
//
// 安全边界：
//   - 只接受 profile.members.admin_open_ids 里的人回复；admin 列表为空 → 自动降级 notify
//   - 远端只能「本次允许」，绝不输出 updatedPermissions（不写 always-allow 规则）
//   - 每次决策 / 超时写 events.log 审计行 `BOT_INFO|permission-bridge|allow|deny|timeout|...`
//   - 发群前走 runtime/redact.js 脱敏（命令里可能带 token / 真名 / 手机号）
//   - 管理员的回复消息 id 追加进 poll.emitted，poll.js 不会再把它当新任务 emit 给主会话
//
// hook 输出契约（CC 只认 stdout JSON）：
//   允许：{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
//   拒绝：{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"..."}}}
//   不表态：不输出任何 stdout，exit 0
//
// CLI：
//   permission-bridge.js                              # hook 模式（stdin 读 CC payload）
//   permission-bridge.js status --project <root>      # 只读：配置 / hook 是否注册 / pending（doctor 用）
//   permission-bridge.js probe  --project <root> [--mode notify|approve] [--wait <secs>]
//                                                     # 不经 CC，模拟一条「需要授权」走完整流程（联调用）

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { atomicWriteSync } = require('./atomic-write')
const redact = require('./redact')
const { createAdapter, resolveLocale } = require('../adapters/factory')

const DEFAULT_WAIT_SECS = 90
const MIN_WAIT_SECS = 10
const MAX_WAIT_SECS = 540          // CC hook 默认 600s 超时，留 60s 余量
const NOTIFY_DEDUP_MS = 30 * 1000  // CC 对同一工具调用可能短时间重复问；30s 内同 key 只发一条
const PENDING_TTL_MS = 10 * 60 * 1000
const POLL_MS_BY_IM = { lark: 3000, slack: 15000 }  // slack conversations.history 限流严，放慢
const PAGE_SIZE = 15
const SUMMARY_MAX = 400

const ALLOW_WORDS = new Set(['允许', '同意', '批准', '放行', 'allow', 'approve', 'approved', 'yes', 'y', 'ok', '1'])
const DENY_WORDS = new Set(['拒绝', '不允许', '不行', '否', 'deny', 'reject', 'rejected', 'no', 'n', '2'])

// ========== 小工具 ==========

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function readStdinJson() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')) } catch { return null }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function paths(root) {
  const ccb = path.join(root, '.cc-bot')
  const rt = path.join(ccb, 'runtime')
  return {
    ccb, rt,
    profile: path.join(ccb, 'profiles', 'active.json'),
    state: path.join(rt, 'state.json'),
    emitted: path.join(rt, 'poll.emitted'),
    events: path.join(rt, 'events.log'),
    bridge: path.join(rt, 'permission-bridge.json'),   // { recent: [{key, ts}], pending: [{id, ts, deadline, tool}] }
  }
}

function logEvent(P, line) {
  try { fs.appendFileSync(P.events, `${new Date().toISOString()} ${line}\n`) } catch {}
}

function appendEmitted(P, id) {
  try { fs.appendFileSync(P.emitted, id + '\n') } catch {}
}

function loadBridgeState(P) {
  const st = readJson(P.bridge) || {}
  const now = Date.now()
  st.recent = (Array.isArray(st.recent) ? st.recent : []).filter(r => now - Number(r.ts || 0) < NOTIFY_DEDUP_MS * 2)
  st.pending = (Array.isArray(st.pending) ? st.pending : []).filter(p => now - Number(p.ts || 0) < PENDING_TTL_MS && Number(p.deadline || 0) > now)
  return st
}

function saveBridgeState(P, st) {
  try { atomicWriteSync(P.bridge, JSON.stringify(st)) } catch {}
}

function shortId() {
  // 4 位小写字母数字；避开所有关键词（deny 等 4 字词）防跟回复关键词撞车
  for (;;) {
    const id = crypto.randomBytes(3).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4)
    if (id.length === 4 && !ALLOW_WORDS.has(id) && !DENY_WORDS.has(id)) return id
  }
}

function resolveConfig(profile) {
  const c = (profile && profile.permission_bridge) || {}
  const wait = Math.max(MIN_WAIT_SECS, Math.min(MAX_WAIT_SECS, Number(c.wait_secs) || DEFAULT_WAIT_SECS))
  return {
    enabled: c.enabled === true,
    mode: c.mode === 'approve' ? 'approve' : 'notify',
    waitSecs: wait,
  }
}

function admins(profile) {
  const list = profile && profile.members && profile.members.admin_open_ids
  return Array.isArray(list) ? list.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []
}

// 把 tool_input 压成一行人话；长命令保留前几行；项目内路径显示为相对路径（群里看得懂、也短）
function summarize(toolName, toolInput, root) {
  const ti = toolInput || {}
  const rel = (f) => {
    const x = String(f || '')
    if (root && x.startsWith(root + path.sep)) return './' + path.relative(root, x).split(path.sep).join('/')
    return x
  }
  let s = ''
  if (toolName === 'Bash') s = String(ti.command || '')
  else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'].includes(toolName)) s = rel(ti.file_path || ti.notebook_path || '')
  else if (toolName === 'WebFetch') s = String(ti.url || '')
  else if (toolName === 'WebSearch') s = String(ti.query || '')
  else if (toolName === 'Glob' || toolName === 'Grep') s = `${ti.pattern || ''} ${ti.path || ''}`.trim()
  if (!s) { try { s = JSON.stringify(ti) } catch { s = String(ti) } }
  const lines = s.split(/\r?\n/)
  if (lines.length > 6) s = lines.slice(0, 6).join('\n') + `\n… (+${lines.length - 6} lines)`
  if (s.length > SUMMARY_MAX) s = s.slice(0, SUMMARY_MAX) + '…'
  return s
}

function renderPrompt({ locale, id, toolName, summary, mode, waitSecs }) {
  const en = locale === 'en-US'
  const head = en ? `🔐 Permission needed #${id}` : `🔐 需要授权 #${id}`
  const tool = en ? `Tool · ${toolName}` : `工具 · ${toolName}`
  const body = en ? `Input · ${summary}` : `内容 · ${summary}`
  const tail = mode === 'approve'
    ? (en ? `Reply "allow ${id}" / "deny ${id}" to decide (admins only, within ${waitSecs}s)`
          : `回复「允许 ${id}」或「拒绝 ${id}」代答（仅管理员，${waitSecs}s 内有效）`)
    : (en ? `Waiting for confirmation at the terminal` : `主会话等待终端确认中`)
  return [head, tool, body, tail].join('\n')
}

function renderAck({ locale, id, behavior }) {
  const en = locale === 'en-US'
  if (behavior === 'allow') return en ? `✓ Allowed #${id}` : `✓ 已允许 #${id}`
  return en ? `✕ Denied #${id}` : `✕ 已拒绝 #${id}`
}

// 解析管理员回复。整条消息必须就是「关键词 [#id]」或「[#id] 关键词」，别的都不算（防把闲聊误判成授权）。
// 返回 'allow' | 'deny' | null
function parseReply(content, myId, solePending) {
  let t = String(content || '').trim().toLowerCase()
  t = t.replace(/<@[a-z0-9]+>/g, ' ')         // slack <@U..>
       .replace(/@[^\s]+/g, ' ')              // lark 渲染后的 @名字
       .replace(/[，。！!,.]+$/g, '')
       .trim()
  if (!t || t.length > 24) return null
  const tokens = t.split(/\s+/).filter(Boolean)
  if (tokens.length === 0 || tokens.length > 2) return null
  let word = null, id = null
  for (const tok of tokens) {
    if (ALLOW_WORDS.has(tok) || DENY_WORDS.has(tok)) { if (word) return null; word = tok; continue }
    const m = /^#?([a-z0-9]{4})$/.exec(tok)
    if (m) { if (id) return null; id = m[1]; continue }
    return null
  }
  if (!word) return null
  if (id && id !== myId) return null
  if (!id && !solePending) return null
  return ALLOW_WORDS.has(word) ? 'allow' : 'deny'
}

function emitDecision(behavior, message) {
  const decision = behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: message || 'denied by cc-bot group admin' }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }) + '\n')
}

// 从 listRecentMessages（降序）里挑出「比我们那条提示更新」的消息：先按 id 切（时钟无关），切不到再按时间
function newerThanPrompt(msgs, promptId, sentAtMs) {
  const idx = promptId ? msgs.findIndex(m => m && m.id === promptId) : -1
  const slice = idx >= 0 ? msgs.slice(0, idx) : msgs.filter(m => m && Number(m.createTimeMs || 0) >= sentAtMs - 5000)
  return [...slice].reverse()  // 升序
}

// ========== 主流程 ==========

async function handleRequest({ root, profile, toolName, toolInput, source }) {
  const P = paths(root)
  const cfg = resolveConfig(profile)
  const locale = resolveLocale(profile)
  const im = profile.im || {}
  let mode = cfg.mode
  const adminList = admins(profile)
  if (mode === 'approve' && adminList.length === 0) {
    logEvent(P, `BOT_WARN|permission-bridge|no-admins|approve 需要 members.admin_open_ids，已降级 notify`)
    mode = 'notify'
  }

  const summaryRaw = summarize(toolName, toolInput, path.resolve(root))
  const summary = redact.text(summaryRaw, profile)
  const key = crypto.createHash('sha1').update(`${toolName}\n${JSON.stringify(toolInput || {})}`).digest('hex').slice(0, 12)

  const st = loadBridgeState(P)
  if (mode === 'notify') {
    const dup = st.recent.find(r => r.key === key && Date.now() - r.ts < NOTIFY_DEDUP_MS)
    if (dup) return { outcome: 'dedup' }
  }

  let adapter
  try { adapter = createAdapter(profile) } catch (e) {
    logEvent(P, `BOT_WARN|permission-bridge|adapter-init|${e.message}`)
    return { outcome: 'adapter-error' }
  }

  const id = shortId()
  const text = renderPrompt({ locale, id, toolName, summary, mode, waitSecs: cfg.waitSecs })
  let promptId = ''
  const sentAt = Date.now()
  try {
    const r = await adapter.sendText({ chatId: im.chat_id, text })
    promptId = (r && r.id) || ''
  } catch (e) {
    logEvent(P, `BOT_WARN|permission-bridge|send-failed|${(e && e.message) || e}`)
    return { outcome: 'send-failed' }
  }
  st.recent.push({ key, ts: sentAt })
  if (mode === 'notify') {
    saveBridgeState(P, st)
    logEvent(P, `BOT_INFO|permission-bridge|notify|#${id}|tool=${toolName}|src=${source}`)
    return { outcome: 'notified', id }
  }

  // approve：登记 pending，开始等回复
  const deadline = sentAt + cfg.waitSecs * 1000
  st.pending.push({ id, ts: sentAt, deadline, tool: toolName })
  saveBridgeState(P, st)
  logEvent(P, `BOT_INFO|permission-bridge|ask|#${id}|tool=${toolName}|wait=${cfg.waitSecs}s|src=${source}`)

  const pollMs = POLL_MS_BY_IM[im.type] || 5000
  let result = null
  try {
    while (Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(200, deadline - Date.now())))
      let msgs
      try { msgs = await adapter.listRecentMessages({ chatId: im.chat_id, pageSize: PAGE_SIZE }) } catch { continue }
      const cur = loadBridgeState(P)
      const solePending = cur.pending.filter(p => p.id !== id).length === 0
      for (const m of newerThanPrompt(msgs || [], promptId, sentAt)) {
        if (!m || !m.id || m.senderType !== 'user') continue
        if (!adminList.includes(m.senderId)) continue
        const behavior = parseReply(m.content, id, solePending)
        if (!behavior) continue
        result = { behavior, by: m.senderId, replyId: m.id }
        break
      }
      if (result) break
    }
  } finally {
    const cur = loadBridgeState(P)
    cur.pending = cur.pending.filter(p => p.id !== id)
    saveBridgeState(P, cur)
  }

  if (!result) {
    logEvent(P, `BOT_INFO|permission-bridge|timeout|#${id}|tool=${toolName}|交回终端`)
    return { outcome: 'timeout', id }
  }

  // 管理员那条回复不该再被 poll.js 当新消息推给主会话
  appendEmitted(P, result.replyId)
  logEvent(P, `BOT_INFO|permission-bridge|${result.behavior}|#${id}|tool=${toolName}|by=${result.by}|reply=${result.replyId}`)
  try {
    await adapter.sendText({ chatId: im.chat_id, replyTo: result.replyId, text: renderAck({ locale, id, behavior: result.behavior }) })
  } catch {}
  return { outcome: result.behavior, id, by: result.by }
}

// ---- hook 入口 ----
async function hookMain() {
  const payload = readStdinJson()
  if (!payload || payload.hook_event_name !== 'PermissionRequest') return
  const root = payload.cwd || process.cwd()
  const P = paths(root)
  const profile = readJson(P.profile)
  if (!profile) return                                  // 非 cc-bot 项目
  const cfg = resolveConfig(profile)
  if (!cfg.enabled) return                              // 默认关
  const state = readJson(P.state) || {}
  if (state.paused !== false) return                    // bot 没在跑 → 本地在用终端，不打扰群
  const toolName = String(payload.tool_name || 'unknown')
  const r = await handleRequest({ root, profile, toolName, toolInput: payload.tool_input, source: 'hook' })
  if (r && (r.outcome === 'allow' || r.outcome === 'deny')) {
    emitDecision(r.outcome, r.outcome === 'deny' ? `cc-bot: denied by group admin (#${r.id})` : '')
  }
}

// ---- CLI：status / probe ----
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = argv[i + 1]
      if (v !== undefined && !v.startsWith('--')) { out[k] = v; i++ } else out[k] = true
    } else out._.push(a)
  }
  return out
}

function hookRegistered() {
  const settings = readJson(path.join(os.homedir(), '.claude', 'settings.json')) || {}
  const arr = settings.hooks && settings.hooks.PermissionRequest
  if (!Array.isArray(arr)) return false
  return arr.some(e => Array.isArray(e && e.hooks) && e.hooks.some(h => String(h && h.command || '').includes('permission-bridge.js')))
}

function statusCmd(args) {
  const root = path.resolve(args.project || process.cwd())
  const P = paths(root)
  const profile = readJson(P.profile)
  if (!profile) { console.log(JSON.stringify({ ok: false, reason: 'profile-missing' })); process.exitCode = 1; return }
  const cfg = resolveConfig(profile)
  const st = loadBridgeState(P)
  console.log(JSON.stringify({
    ok: true,
    enabled: cfg.enabled,
    mode: cfg.mode,
    wait_secs: cfg.waitSecs,
    admins: admins(profile).length,
    hook_registered: hookRegistered(),
    pending: st.pending,
  }))
}

async function probeCmd(args) {
  const root = path.resolve(args.project || process.cwd())
  const P = paths(root)
  const profile = readJson(P.profile)
  if (!profile) { console.log(JSON.stringify({ ok: false, reason: 'profile-missing' })); process.exitCode = 1; return }
  const over = JSON.parse(JSON.stringify(profile))
  over.permission_bridge = { ...(profile.permission_bridge || {}), enabled: true }
  if (args.mode) over.permission_bridge.mode = String(args.mode)
  if (args.wait) over.permission_bridge.wait_secs = Number(args.wait)
  const r = await handleRequest({
    root, profile: over, toolName: 'Bash',
    toolInput: { command: 'echo "cc-bot permission-bridge probe"' }, source: 'probe',
  })
  console.log(JSON.stringify({ ok: true, ...r }))
}

const args = parseArgs(process.argv.slice(2))
const sub = args._[0]
;(async () => {
  try {
    if (sub === 'status') statusCmd(args)
    else if (sub === 'probe') await probeCmd(args)
    else await hookMain()
  } catch {
    // hook 崩溃会拖累主会话；一律静默 exit 0（不表态 = 权限流程原样继续）
  }
  process.exit(sub ? (process.exitCode || 0) : 0)
})()
