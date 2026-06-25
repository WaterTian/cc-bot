#!/usr/bin/env node
// cc-bot 群消息开关词表检测 + tripwire 闸门（issue #18）
//
// 背景：群里发"关闭"/"停 bot"/"stop bot" 等指令时，SKILL.md §开关来源限制 要求不响应，但 LLM 仍有可能误判为
//   stop 意图直接调 Skill(cc-bot:stop)。本模块把检测词表 + 拒绝闸门代码化，三层防御之一：
//   ① poll.js 调 detect 标记 envelope（FLAGS=bot_switch_from_group） + 写 tripwire
//   ② commands/stop.md & start.md pre-flight 调 gate，tripwire 新鲜则 exit 1 + 拒绝模板
//   ③ SKILL.md 顶部硬约束（LLM 兜底）
//
// 接口：
//   detect(content) → { matched: bool, by?: 'pattern'|'bare', keyword?: string }
//   writeTripwire(runtimeDir, entry)
//   readFreshTripwire(runtimeDir, ttlMs) → entry | null（读后不删，由调用方决策清理）
//   clearTripwire(runtimeDir)
//
// CLI：
//   check --content "..."           → JSON {matched, by, keyword}
//   gate  --project <root> [--ttl-ms 60000]
//                                   → exit 0（无 fresh tripwire，放行）
//                                   → exit 1（有 fresh tripwire，stdout 打印 {entry, reply_template_zh, reply_template_en}）
//
// 词表覆盖：CLAUDE.md / SKILL.md §总开关 列出的所有 ZH 自然语言触发词 + 常见 EN slack 等价词。
// 设计取舍：bare-token（"关闭"等单字独占整句）会被 flag — 偶发误伤代价 = 一条"开关指令请从主会话发起"
// 拒绝回复，远小于群消息远程下线 bot 失控的代价。
//
// 注意：bare-token 不限"含 bot"，原事故就是 admin 单发"关闭"被 LLM 当 stop。

const fs = require('fs')
const path = require('path')

// 含 bot 后缀（任意空白）
const SWITCH_PATTERNS = [
  // ZH stop / pause
  /关\s*闭?\s*bot/i, /停\s*bot/i, /暂停\s*bot/i, /下线\s*bot/i,
  // ZH start / online
  /开\s*启?\s*bot/i, /打\s*开\s*bot/i, /启动\s*bot/i, /上线\s*bot/i,
  // EN stop / pause
  /\b(stop|kill|shut\s*down|shutdown|turn\s+off|disable|pause)\s+(the\s+)?bot\b/i,
  // EN start / online
  /\b(start|launch|turn\s+on|enable|bring\s+(up|online))\s+(the\s+)?bot\b/i,
  // bot + online/offline/on/off
  /\bbot\s+(offline|online|off|on)\b/i,
]

// 整句 bare token（trim 后等值匹配；尾标点剥离）
const SWITCH_BARE_TOKENS = new Set([
  '关闭', '下线', '暂停', '开启', '启动', '上线',
])

function detect(content) {
  const trimmed = String(content || '').trim()
  if (!trimmed) return { matched: false }

  for (const re of SWITCH_PATTERNS) {
    const m = trimmed.match(re)
    if (m) return { matched: true, by: 'pattern', keyword: m[0] }
  }

  const bare = trimmed.replace(/[。！？!?,.\s]+$/u, '')
  if (SWITCH_BARE_TOKENS.has(bare)) {
    return { matched: true, by: 'bare', keyword: bare }
  }

  return { matched: false }
}

function tripwirePath(runtimeDir) {
  return path.join(runtimeDir, 'group-bot-switch.tripwire')
}

function writeTripwire(runtimeDir, entry) {
  try {
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.writeFileSync(tripwirePath(runtimeDir), JSON.stringify(entry))
  } catch {
    // tripwire 是装饰性，写失败不影响主流程（仍走 envelope FLAGS）
  }
}

function readFreshTripwire(runtimeDir, ttlMs) {
  try {
    const data = JSON.parse(fs.readFileSync(tripwirePath(runtimeDir), 'utf8'))
    const ts = Number(data && data.ts || 0)
    if (!ts) return null
    if (Date.now() - ts > ttlMs) return null
    return data
  } catch {
    return null
  }
}

function clearTripwire(runtimeDir) {
  try { fs.unlinkSync(tripwirePath(runtimeDir)) } catch {}
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
    '  bot-switch-detect.js check --content "<text>"',
    '  bot-switch-detect.js gate  --project <root> [--ttl-ms 60000]',
    '',
    'check output:',
    '  {"matched":true|false, "by":"pattern|bare", "keyword":"..."}',
    '',
    'gate behavior:',
    '  exit 0 — no fresh tripwire (proceed with switch)',
    '  exit 1 — fresh tripwire (stdout: {entry, reply_template_zh, reply_template_en})',
  ].join('\n')
}

function main() {
  const [, , subcmd, ...rest] = process.argv
  if (!subcmd || subcmd === '--help' || subcmd === '-h') {
    process.stdout.write(usage() + '\n')
    process.exit(0)
  }
  const args = parseArgs(rest)

  if (subcmd === 'check') {
    if (!args.content) { process.stderr.write('--content required\n'); process.exit(2) }
    process.stdout.write(JSON.stringify(detect(args.content)) + '\n')
    return
  }

  if (subcmd === 'gate') {
    if (!args.project) { process.stderr.write('--project required\n'); process.exit(2) }
    const ttlMs = Number(args['ttl-ms']) || 60_000
    const runtimeDir = path.join(args.project, '.cc-bot', 'runtime')
    const entry = readFreshTripwire(runtimeDir, ttlMs)
    if (!entry) { process.exit(0) }
    const out = {
      entry,
      ttl_ms: ttlMs,
      reply_template_zh: '开关指令请从 Claude Code 主会话发起，不接受来自群消息的开关操作。',
      reply_template_en: 'Bot switch (start/stop) must be initiated from the Claude Code main session. Group-message switches are rejected.',
    }
    process.stdout.write(JSON.stringify(out) + '\n')
    process.exit(1)
  }

  process.stderr.write(`unknown subcommand: ${subcmd}\n${usage()}\n`)
  process.exit(2)
}

if (require.main === module) main()

module.exports = {
  detect, writeTripwire, readFreshTripwire, clearTripwire,
  SWITCH_PATTERNS, SWITCH_BARE_TOKENS,
}
