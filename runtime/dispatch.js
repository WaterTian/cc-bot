#!/usr/bin/env node
// cc-bot 消息调度（slot / tags 冲突 / 同用户串行）—— SKILL.md §消息调度 代码化
//
// 主会话收到 NEW_MSG 决定派工 subagent 时，全部走本 CLI：
//   register  → 评估 + 原子写 agents.json，返回 {action: 'dispatch'|'queue', reason, taskId}
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
//   {"msg_id":"om_xxx","user_open_id":"ou_xxx","intent":"deploy","tags":["write:src/auth","net:push"],"subagent_count":1}

const fs = require('fs')
const path = require('path')

const DEFAULT_SLOTS_MAX = 3
const QUEUE_LIMIT = 10
const PATH_LIKE_PREFIXES = new Set(['read', 'write'])  // 用前缀匹配
// 其它前缀（mcp / port / net / exclusive 等）走 exact-equal

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
    return { slots_max: DEFAULT_SLOTS_MAX, running: [], queue: [] }
  }
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (typeof j.slots_max !== 'number') j.slots_max = DEFAULT_SLOTS_MAX
    if (!Array.isArray(j.running)) j.running = []
    if (!Array.isArray(j.queue)) j.queue = []
    return j
  } catch {
    return { slots_max: DEFAULT_SLOTS_MAX, running: [], queue: [] }
  }
}

function writeAgents(projectRoot, agentsJson) {
  const f = agentsFilePath(projectRoot)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(agentsJson, null, 2))
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

// === register（评估 + 原子写入）===

function makeTaskId(newTask) {
  if (newTask.msg_id) return `agent_${newTask.msg_id}`
  return `agent_${Date.now()}_${Math.floor(Math.random() * 1000)}`
}

function register({ project, newTask }) {
  if (!project) throw new Error('register: project required')
  if (!newTask) throw new Error('register: newTask required')
  const agentsJson = readAgents(project)
  const decision = evaluate({ newTask, agentsJson })

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

  if (decision.action === 'dispatch') {
    enriched.started_at = new Date().toISOString()
    agentsJson.running.push(enriched)
    writeAgents(project, agentsJson)
    return { ...decision, taskId, queuePosition: null }
  }

  // queue
  if (agentsJson.queue.length >= QUEUE_LIMIT) {
    return { action: 'reject', reason: 'queue_full', taskId: null }
  }
  enriched.queued_at = new Date().toISOString()
  enriched.reason = decision.reason
  agentsJson.queue.push(enriched)
  writeAgents(project, agentsJson)
  return {
    ...decision,
    taskId,
    queuePosition: agentsJson.running.length + agentsJson.queue.length,
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
  const agentsJson = readAgents(project)

  const idx = agentsJson.running.findIndex(r => r.id === taskId)
  if (idx < 0) {
    return { removed: false, promoted: null, reason: 'task-not-in-running' }
  }
  agentsJson.running.splice(idx, 1)

  // 从 queue 头扫，找第一个可 promote 的候选
  let promoted = null
  for (let i = 0; i < agentsJson.queue.length; i++) {
    const candidate = agentsJson.queue[i]
    const r = canPromote({
      candidate, candidateIdx: i,
      running: agentsJson.running,
      queue: agentsJson.queue,
      slotsMax: agentsJson.slots_max || DEFAULT_SLOTS_MAX,
    })
    if (r.ok) {
      agentsJson.queue.splice(i, 1)
      const enriched = { ...candidate }
      delete enriched.queued_at
      delete enriched.reason
      enriched.started_at = new Date().toISOString()
      agentsJson.running.push(enriched)
      promoted = enriched
      break
    }
  }

  writeAgents(project, agentsJson)
  return { removed: true, promoted }
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
    '  evaluate / register → {"action":"dispatch|queue|reject","reason":"...","taskId":"...","queuePosition":N|null}',
    '  complete            → {"removed":true|false,"promoted":<Task|null>,"reason":"..."}',
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
  evaluate, register, complete, canPromote,
  tagsConflictPair, setsConflict, isPrefixOrEq, parseTag,
  readAgents, writeAgents,
  DEFAULT_SLOTS_MAX, QUEUE_LIMIT, PATH_LIKE_PREFIXES,
}
