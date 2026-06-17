#!/usr/bin/env node
// cc-bot 消息调度（slot / tags 冲突 / 同用户串行）—— SKILL.md §消息调度 代码化
//
// 主会话收到 NEW_MSG 决定派工 subagent 时，全部走本 CLI：
//   register  → 评估 + 原子写 agents.json，返回 {action: 'dispatch'|'queue', reason, taskId, preheated}
//   complete  → 移除 running[taskId]，从 queue 找下一个可跑的并 promote，返回 {promoted: taskId|null}
//   evaluate  → dry-run（不写 state），返回会发生什么
//   ls        → 当前 running + queue dump
//
// 主会话不再手动 Edit agents.json；冲突规则、prefix 匹配、slot 满判定全部在代码内。
//
// agents.json schema：
//   { slots_max: 3, running: [Task[]], queue: [Task[]] }
//   Task: { id, msg_id, user_open_id, intent, tags[], started_at|queued_at, subagent_count, reason? }
//
// 冲突规则（仅 read:* / write:* 两族；其他前缀同 tag 即冲突）：
//   read:X  vs read:Y  → 仅当 X 等于 Y 时不冲突；前缀关系也不冲突（并发只读 OK）
//   read:X  vs write:Y → 若 X 是 Y 前缀或反之 → 冲突
//   write:X vs write:Y → 若 X 是 Y 前缀或反之 → 冲突
//   mcp:X / port:X / net:* / exclusive:X 这类一律 exact-equal = 冲突
//
// CLI 模式：
//   node runtime/dispatch.js evaluate --project <root> --task-json '<JSON>'
//   node runtime/dispatch.js register --project <root> --task-json '<JSON>'
//   node runtime/dispatch.js complete --project <root> --task-id <id>
//   node runtime/dispatch.js ls       --project <root>
//
// task-json 形如：
//   {"msg_id":"om_xxx","user_open_id":"ou_xxx","intent":"deploy","subject":"<可选, ≤60 字人类可读>","tags":["write:src/auth","net:push"],"subagent_count":1}

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const intent = require('./intent')
const { canUseStreamingCard } = require('./streaming-card-policy')
const { atomicWriteSync } = require('./atomic-write')

const DEFAULT_SLOTS_MAX = 3
const QUEUE_LIMIT = 10
const PATH_LIKE_PREFIXES = new Set(['read', 'write'])  // 用前缀匹配
// 其它前缀（mcp / port / net / exclusive 等）走 exact-equal
const STREAMING_CARD_CLI = path.join(__dirname, 'streaming-card.js')
const PREHEAT_TIMEOUT_MS = 3000  // 预热卡 / 孤儿兜底 finalize 的硬上限

// === 冲突逻辑 ===

function parseTag(t) {
  const i = String(t || '').indexOf(':')
  if (i < 0) return { prefix: t, value: '' }
  return { prefix: t.slice(0, i), value: t.slice(i + 1) }
}

function isPrefixOrEq(a, b) {
  if (a === b) return true
  // 目录前缀匹配（按 / 分段，避免 src/auth 误吃 src/authorize）
  const aSlash = a.endsWith('/') ? a : a + '/'
  const bSlash = b.endsWith('/') ? b : b + '/'
  return aSlash.startsWith(bSlash) || bSlash.startsWith(aSlash)
}

function tagsConflictPair(t1, t2) {
  const p1 = parseTag(t1)
  const p2 = parseTag(t2)
  // 非 read/write 前缀：完全相等才算冲突
  if (!PATH_LIKE_PREFIXES.has(p1.prefix) && !PATH_LIKE_PREFIXES.has(p2.prefix)) {
    return t1 === t2 ? { conflict: true, reason: `exclusive-tag:${t1}` } : { conflict: false }
  }
  // 至少一方是 read/write：只关心同时是 path-like
  if (!(PATH_LIKE_PREFIXES.has(p1.prefix) && PATH_LIKE_PREFIXES.has(p2.prefix))) {
    return { conflict: false }
  }
  // 路径无重叠 → 不冲突
  if (!isPrefixOrEq(p1.value, p2.value)) return { conflict: false }
  // 双方都是 read → 并发读 OK
  if (p1.prefix === 'read' && p2.prefix === 'read') return { conflict: false }
  // read vs write 或 write vs write 路径重叠 → 冲突
  return { conflict: true, reason: `path-overlap:${p1.prefix}:${p1.value}↔${p2.prefix}:${p2.value}` }
}

function setsConflict(tagsA, tagsB) {
  for (const a of (tagsA || [])) {
    for (const b of (tagsB || [])) {
      const r = tagsConflictPair(a, b)
      if (r.conflict) return r
    }
  }
  return { conflict: false }
}

// === agents.json IO ===

function agentsFilePath(projectRoot) {
  return path.join(projectRoot, '.cc-bot', 'runtime', 'agents.json')
}

function readAgents(projectRoot) {
  const f = agentsFilePath(projectRoot)
  if (!fs.existsSync(f)) {
    return { version: 1, slots_max: DEFAULT_SLOTS_MAX, running: [], queue: [] }
  }
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (typeof j.version !== 'number') j.version = 1
    if (typeof j.slots_max !== 'number') j.slots_max = DEFAULT_SLOTS_MAX
    if (!Array.isArray(j.running)) j.running = []
    if (!Array.isArray(j.queue)) j.queue = []
    return j
  } catch {
    return { version: 1, slots_max: DEFAULT_SLOTS_MAX, running: [], queue: [] }
  }
}

function writeAgents(projectRoot, agentsJson) {
  atomicWriteSync(agentsFilePath(projectRoot), JSON.stringify(agentsJson, null, 2))
}

// v0.1.37+ 乐观 CAS — register/complete/sweep 并发改 agents.json 时，靠 version 字段防 lost update。
// 读 → 改 → 再读校 version → 没变就 bump+写；变了就重试。N 次后抛错（极少触发，主用作信号 not 兜底）。
// fn(agents) 在内存里改 agents 对象；返回值随 withCAS 返回（side effects 应在 withCAS 之外做）。
const CAS_MAX_RETRIES = 5
function withCAS(project, fn) {
  for (let attempt = 0; attempt < CAS_MAX_RETRIES; attempt++) {
    const agents = readAgents(project)
    const expected = agents.version
    const result = fn(agents)
    const fresh = readAgents(project)
    if (fresh.version !== expected) continue  // raced，重试
    agents.version = expected + 1
    writeAgents(project, agents)
    return result
  }
  throw new Error(`agents.json CAS exhausted ${CAS_MAX_RETRIES} retries (concurrent write contention)`)
}

// === 决策 ===

function evaluate({ newTask, agentsJson }) {
  if (!newTask) throw new Error('evaluate: newTask required')
  const slotsMax = agentsJson.slots_max || DEFAULT_SLOTS_MAX
  const running = agentsJson.running || []
  const queue = agentsJson.queue || []

  // 1. slot 满
  if (running.length >= slotsMax) {
    return { action: 'queue', reason: 'slot_full' }
  }

  // 2. tag 冲突
  for (const r of running) {
    const c = setsConflict(newTask.tags, r.tags)
    if (c.conflict) {
      return { action: 'queue', reason: `conflict:${c.reason}` }
    }
  }

  // 3. 同 user 已在 running 或 queue 头部 → 串行
  if (newTask.user_open_id) {
    const inRunning = running.some(r => r.user_open_id === newTask.user_open_id)
    const inQueue   = queue.some(q => q.user_open_id === newTask.user_open_id)
    if (inRunning || inQueue) {
      return { action: 'queue', reason: 'user_serial' }
    }
  }

  // 4. 派单
  return { action: 'dispatch', reason: 'allowed' }
}

// === 卡片预热 + 孤儿兜底（v0.1.33+，issue #15）===

// 预热卡：dispatch 决定派单时同步在 dispatch.js 里建卡，把首次 cardkit POST 从
// worker 关键路径挪到 dispatch 侧。首帧 6-10s → 1-2s。
// 仅 lark + streaming_card.enabled 才预热；slack / 关卡场景维持主会话"回群占位"原行为。
// 3s 超时静默吞掉：失败时无 state 文件 → worker 首次 report 走路径 2 自建卡，等价旧行为。
function preheatCard({ project, newTask }) {
  if (!newTask || !newTask.msg_id) return false
  let profile
  try {
    profile = JSON.parse(fs.readFileSync(
      path.join(project, '.cc-bot', 'profiles', 'active.json'), 'utf8'))
  } catch { return false }
  if (!canUseStreamingCard(profile).ok) return false

  const subject = pickSubject(newTask, profile)
  const content = `**接到任务：${subject}**\n\n排队中，启动 worker...`
  try {
    execFileSync('node', [
      STREAMING_CARD_CLI, 'report',
      '--project', project,
      '--msg-id', newTask.msg_id,
      '--content', content,
    ], { stdio: 'ignore', timeout: PREHEAT_TIMEOUT_MS, windowsHide: true })
  } catch {
    // 超时 / 失败 → 忽略；worker 首次 report 会自己建卡兜底
    return false
  }
  // 成功标准：state 文件存在且 mode=card（reply / fallback 都视作未预热，主会话仍需占位）
  const stateFile = path.join(project, '.cc-bot', 'runtime', `stream-${newTask.msg_id}.json`)
  try {
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    return st && st.mode === 'card'
  } catch { return false }
}

// 优先级：主会话显式 subject > intent description 首句 > 通用兜底。
// intent description 截到首个句号/换行 + 60 字（参 intent.js listAvailable 同款截法）。
function pickSubject(newTask, profile) {
  const explicit = String(newTask.subject || '').trim()
  if (explicit) return explicit.slice(0, 60)
  const r = intent.resolveAction(newTask.intent, profile)
  if (r && r.found && r.description) {
    const first = String(r.description).split(/[。\.\n]/)[0].trim().slice(0, 60)
    if (first) return first
  }
  return '处理中'
}

// 孤儿兜底 finalize：worker 完成回收时若卡片仍 running → 强制 finalize 为 error。
// 正常路径上 worker 已经 --final 过，state.terminal !== 'running'，CLI 路径 3b 幂等返回。
// 异常路径（worker 崩 / 卡死被 kill / 模型异常退出）下避免"● 处理中"挂群里不收口。
function finalizeStrandedCard({ project, removed }) {
  if (!removed || !removed.msg_id) return
  const stateFile = path.join(project, '.cc-bot', 'runtime', `stream-${removed.msg_id}.json`)
  let state
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return }
  if (state.mode !== 'card' || state.terminal !== 'running') return
  try {
    execFileSync('node', [
      STREAMING_CARD_CLI, 'report',
      '--project', project,
      '--msg-id', removed.msg_id,
      '--final',
      '--status', 'error',
      '--error-msg', 'worker 异常退出，未发回结论',
    ], { stdio: 'ignore', timeout: PREHEAT_TIMEOUT_MS, windowsHide: true })
  } catch {}
}

// === register（评估 + 原子写入）===

function makeTaskId(newTask) {
  if (newTask.msg_id) return `agent_${newTask.msg_id}`
  return `agent_${Date.now()}_${Math.floor(Math.random() * 1000)}`
}

function register({ project, newTask }) {
  if (!project) throw new Error('register: project required')
  if (!newTask) throw new Error('register: newTask required')

  const taskId = makeTaskId(newTask)
  const enriched = {
    id: taskId,
    msg_id: newTask.msg_id || '',
    user_open_id: newTask.user_open_id || '',
    user_name: newTask.user_name || '',
    intent: newTask.intent || '',
    tags: Array.isArray(newTask.tags) ? newTask.tags : [],
    subagent_count: newTask.subagent_count || 1,
  }

  // CAS-only：评估 + 修改 + 写。preheat / 文本占位等 side effects 放 CAS 外做（重试不重发）。
  const outcome = withCAS(project, (agents) => {
    const decision = evaluate({ newTask, agentsJson: agents })
    if (decision.action === 'dispatch') {
      enriched.started_at = new Date().toISOString()
      enriched.started_at_ms = Date.now()  // v0.1.37+ sweep 用 epoch ms 比较超时
      agents.running.push(enriched)
      return { decision, queuePosition: null }
    }
    if (agents.queue.length >= QUEUE_LIMIT) {
      return { decision: { action: 'reject', reason: 'queue_full' }, queuePosition: null, rejected: true }
    }
    enriched.queued_at = new Date().toISOString()
    enriched.reason = decision.reason
    agents.queue.push(enriched)
    return { decision, queuePosition: agents.running.length + agents.queue.length }
  })

  if (outcome.rejected) {
    return { action: 'reject', reason: 'queue_full', taskId: null, preheated: false }
  }

  // 派单决定后立刻预热卡片（lark + streaming_card 开 才会真建卡，其它场景 no-op）
  // preheated=true 时主会话不需要再回群占位（卡已建好，hero "排队中..."）；
  // false 时主会话照常发占位文本——这是 SKILL.md L483-485 唯一需要看的字段。
  let preheated = false
  if (outcome.decision.action === 'dispatch') {
    preheated = !!preheatCard({ project, newTask })
  }
  return {
    ...outcome.decision,
    taskId,
    queuePosition: outcome.queuePosition,
    preheated,
  }
}

// === complete（移除 running + queue 扫描 promote）===

// canPromote: 给 queue[idx] 看在当前 running 状态下能否上位
//   - slot 有空
//   - tags 不与 running 冲突
//   - 同 user 不在 running 里
//   - 队列里同 user 的更早任务（candidateIdx 之前）没有 → 保证同 user FIFO
function canPromote({ candidate, candidateIdx, running, queue, slotsMax }) {
  if (running.length >= slotsMax) return { ok: false, reason: 'slot_full' }
  for (const r of running) {
    const c = setsConflict(candidate.tags, r.tags)
    if (c.conflict) return { ok: false, reason: `conflict:${c.reason}` }
  }
  if (candidate.user_open_id) {
    if (running.some(r => r.user_open_id === candidate.user_open_id)) {
      return { ok: false, reason: 'user_serial' }
    }
    for (let i = 0; i < candidateIdx; i++) {
      if (queue[i].user_open_id === candidate.user_open_id) {
        return { ok: false, reason: 'user_serial_earlier_in_queue' }
      }
    }
  }
  return { ok: true }
}

function complete({ project, taskId }) {
  if (!project) throw new Error('complete: project required')
  if (!taskId) throw new Error('complete: taskId required')

  const result = withCAS(project, (agents) => {
    const idx = agents.running.findIndex(r => r.id === taskId)
    if (idx < 0) return { notFound: true }
    const removed = agents.running[idx]
    agents.running.splice(idx, 1)

    let promoted = null
    for (let i = 0; i < agents.queue.length; i++) {
      const candidate = agents.queue[i]
      const r = canPromote({
        candidate, candidateIdx: i,
        running: agents.running,
        queue: agents.queue,
        slotsMax: agents.slots_max || DEFAULT_SLOTS_MAX,
      })
      if (r.ok) {
        agents.queue.splice(i, 1)
        const enriched = { ...candidate }
        delete enriched.queued_at
        delete enriched.reason
        enriched.started_at = new Date().toISOString()
        enriched.started_at_ms = Date.now()
        agents.running.push(enriched)
        promoted = enriched
        break
      }
    }
    return { notFound: false, removed, promoted }
  })

  if (result.notFound) {
    return { removed: false, promoted: null, reason: 'task-not-in-running' }
  }
  const { removed, promoted } = result

  // 孤儿卡片兜底（worker 异常退出时 state 仍 running → 强制 finalize 为 error，幂等）
  finalizeStrandedCard({ project, removed })
  return { removed: true, promoted }
}

// === sweep（v0.1.37+，长任务 wall-clock cap）===
//
// poll.js 每 tick 调一次。读 profile.dispatch.max_turn_time_mins（默认 0=不启用），扫 running 超时项：
//   - 调 streaming-card.js 兜底 finalize 卡片为 "已超时" (status=error，按 im.locale 双语)
//   - splice running + 扫 queue promote 后继任务
//   - 不杀 worker 进程（CLAUDE.md 禁跨项目杀 node；worker EPIPE 自然退出）
// CAS 失败 / profile 读不到 / max=0 → no-op 返回 swept=0。

const TIMEOUT_MSGS = {
  'zh-CN': (mins) => `任务超时（${mins} min 上限）`,
  'en-US': (mins) => `Task timed out (${mins} min limit)`,
}

function readProfileSafe(project) {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(project, '.cc-bot', 'profiles', 'active.json'), 'utf8'))
  } catch { return null }
}

function localeOf(profile) {
  const im = (profile && profile.im) || {}
  if (im.locale) return im.locale
  return im.type === 'slack' ? 'en-US' : 'zh-CN'
}

function finalizeTimeoutCard({ project, task, locale, maxMins }) {
  if (!task || !task.msg_id) return
  const stateFile = path.join(project, '.cc-bot', 'runtime', `stream-${task.msg_id}.json`)
  let state
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return }
  if (state.mode !== 'card' || state.terminal !== 'running') return
  const msgFn = TIMEOUT_MSGS[locale] || TIMEOUT_MSGS['zh-CN']
  try {
    execFileSync('node', [
      STREAMING_CARD_CLI, 'report',
      '--project', project,
      '--msg-id', task.msg_id,
      '--final', '--status', 'error',
      '--error-msg', msgFn(maxMins),
    ], { stdio: 'ignore', timeout: PREHEAT_TIMEOUT_MS, windowsHide: true })
  } catch {}
}

function sweep({ project }) {
  if (!project) throw new Error('sweep: project required')
  const profile = readProfileSafe(project)
  const maxMins = Number(profile && profile.dispatch && profile.dispatch.max_turn_time_mins) || 0
  if (maxMins <= 0) return { swept: 0, reason: 'disabled' }

  const maxMs = maxMins * 60 * 1000
  const now = Date.now()
  const locale = localeOf(profile)

  // CAS 阶段：纯算 + 写。卡片 finalize 在 CAS 外做（重试不重发）。
  const toSweep = []
  let promoted = null
  try {
    withCAS(project, (agents) => {
      const remain = []
      for (const r of agents.running) {
        const startedMs = Number(r.started_at_ms || 0)
        if (startedMs > 0 && (now - startedMs) >= maxMs) {
          toSweep.push(r)
        } else {
          remain.push(r)
        }
      }
      if (toSweep.length === 0) return
      agents.running = remain

      // 扫 queue promote 后继（沿用 complete 的 canPromote）
      for (let i = 0; i < agents.queue.length; i++) {
        const candidate = agents.queue[i]
        const r = canPromote({
          candidate, candidateIdx: i,
          running: agents.running,
          queue: agents.queue,
          slotsMax: agents.slots_max || DEFAULT_SLOTS_MAX,
        })
        if (r.ok) {
          agents.queue.splice(i, 1)
          const enriched = { ...candidate }
          delete enriched.queued_at
          delete enriched.reason
          enriched.started_at = new Date().toISOString()
          enriched.started_at_ms = now
          agents.running.push(enriched)
          promoted = enriched
          break  // 一次 sweep 只 promote 一个（poll.js 下一 tick 再 promote 后续）
        }
      }
    })
  } catch (e) {
    return { swept: 0, error: e.message }
  }

  if (toSweep.length === 0) return { swept: 0 }

  // CAS 成功后 finalize 卡片（重试场景下卡片仍 running 则 finalize；已被别处 finalize 走 path 3b 幂等）
  for (const task of toSweep) {
    finalizeTimeoutCard({ project, task, locale, maxMins })
  }

  return {
    swept: toSweep.length,
    swept_ids: toSweep.map(t => t.id),
    promoted: promoted ? promoted.id : null,
  }
}

// === CLI ===

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
    '  dispatch.js evaluate --project <root> --task-json <JSON>   # dry-run, 不写 state',
    '  dispatch.js register --project <root> --task-json <JSON>   # 评估 + 原子写 agents.json',
    '  dispatch.js complete --project <root> --task-id <id>       # 移除 running + 尝试 promote queue',
    '  dispatch.js sweep    --project <root>                       # 扫超时 running，按 dispatch.max_turn_time_mins finalize 卡片',
    '  dispatch.js ls       --project <root>                       # dump 当前 agents.json',
    '',
    'task-json schema: {"msg_id","user_open_id","user_name","intent","tags":[...]}',
    'tag prefixes:',
    '  read:<path>  / write:<path>  — 路径前缀冲突（read-read 不冲）',
    '  mcp:<name>   — 独占 MCP',
    '  port:<n>     — dev server 端口',
    '  net:push     — 部署/推送类',
    '  exclusive:git — git 操作',
    '',
    'Output:',
    '  evaluate / register → {"action":"dispatch|queue|reject","reason":"...","taskId":"...","queuePosition":N|null,"preheated":bool}',
    '  complete            → {"removed":true|false,"promoted":<Task|null>,"reason":"..."}',
    '  sweep               → {"swept":N,"swept_ids":[...],"promoted":<id|null>,"reason":"disabled"?}',
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
    if (subcmd === 'evaluate' || subcmd === 'register') {
      if (!args['task-json']) throw new Error('--task-json required')
      let newTask
      try { newTask = JSON.parse(args['task-json']) }
      catch (e) { throw new Error('bad --task-json: ' + e.message) }
      if (subcmd === 'evaluate') {
        const r = evaluate({ newTask, agentsJson: readAgents(args.project) })
        process.stdout.write(JSON.stringify(r) + '\n')
      } else {
        const r = register({ project: args.project, newTask })
        process.stdout.write(JSON.stringify(r) + '\n')
      }
    } else if (subcmd === 'complete') {
      if (!args['task-id']) throw new Error('--task-id required')
      const r = complete({ project: args.project, taskId: args['task-id'] })
      process.stdout.write(JSON.stringify(r) + '\n')
    } else if (subcmd === 'sweep') {
      const r = sweep({ project: args.project })
      process.stdout.write(JSON.stringify(r) + '\n')
    } else if (subcmd === 'ls') {
      process.stdout.write(JSON.stringify(readAgents(args.project), null, 2) + '\n')
    } else {
      process.stderr.write(`unknown subcommand: ${subcmd}\n${usage()}\n`)
      process.exit(2)
    }
  } catch (e) {
    process.stderr.write(`ERROR: ${e && e.message || e}\n`)
    process.exit(1)
  }
}

if (require.main === module) main()

module.exports = {
  evaluate, register, complete, sweep, canPromote,
  tagsConflictPair, setsConflict, isPrefixOrEq, parseTag,
  readAgents, writeAgents, withCAS,
  DEFAULT_SLOTS_MAX, QUEUE_LIMIT, PATH_LIKE_PREFIXES,
}
