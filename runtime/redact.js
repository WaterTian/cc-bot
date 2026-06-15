#!/usr/bin/env node
// cc-bot 文本脱敏 / 隐私 scrub
//
// 群消息发送前过一遍，强制替换 token / 真名 / 长 hex ID 等敏感串。
// 当前靠 worker LLM 自觉「禁出现 token / 真名」，code 强制后零依赖。
// 设计参考：cc-connect core/redact.go
//
// 接口：
//   redact.text(input, profile)
//     → string（已脱敏）
//   redact.detect(input, profile)
//     → { hits: [{kind, sample, count}], cleanText }
//
// CLI 模式：
//   node runtime/redact.js scrub  --project <root> [--text <s> | --stdin]
//   node runtime/redact.js detect --project <root> [--text <s> | --stdin]
//
// 脱敏规则（按命中顺序，从更具体到更宽泛）：
//   1. Slack 各类 token：xox[bopca]-...
//   2. Slack app-level token：xapp-...
//   3. Bearer 头：Bearer <jwt 或长 hex/base64>
//   4. 显式 key=value 形态的 secret：app_secret / client_secret / api_key / token / password
//   5. JWT 三段：eyJxxx.eyJxxx.xxx
//   6. 飞书 14+ hex 应用 ID：cli_[a-f0-9]{14,}
//   7. 飞书 open_id：ou_[a-z0-9]{20,}
//   8. 飞书 message id：om_[a-z0-9]{20,}（运维场景可见但属于隐私）
//   9. 邮箱
//   10. 中国大陆手机号
//   11. profile.privacy.blocklist 自定义真名

const fs = require('fs')
const path = require('path')

// 按 [kind, regex] 顺序匹配；先具体后宽泛防误吃
// 注意：所有正则用 g flag 全量替换，捕获组在替换函数内部用
const PATTERNS = [
  // tokens — 高敏感
  ['slack_xoxb', /xox[bopca]-[A-Za-z0-9-]{6,}/g],
  ['slack_xapp', /xapp-\d+-[A-Za-z0-9-]{6,}/g],
  ['bearer',    /Bearer\s+[A-Za-z0-9._\-]{16,}/gi],
  ['jwt',       /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['secret_kv', /(app_secret|client_secret|api_key|access_token|refresh_token|password|secret)\s*[=:]\s*['"]?([A-Za-z0-9_\-\.]{12,})['"]?/gi],

  // 飞书 ID — 中敏感
  ['lark_app_id', /cli_[a-f0-9]{14,}/g],
  ['lark_open_id', /ou_[a-zA-Z0-9]{20,}/g],
  ['lark_msg_id', /om_[a-zA-Z0-9]{20,}/g],

  // PII
  ['email', /[\w.+\-]+@[\w\-]+\.[\w\-.]+/g],
  ['phone_cn', /(?<![\d])1[3-9]\d{9}(?![\d])/g],
]

function blocklistPatterns(profile) {
  const list = (profile && profile.privacy && profile.privacy.blocklist) || []
  return list.filter(s => typeof s === 'string' && s.trim().length >= 2).map(name => {
    // 真名直接全词替换；不区分大小写在中文里无意义，但留 i flag 兼顾英文名
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return ['real_name', new RegExp(escaped, 'g'), name]
  })
}

function blocklistReplace(profile) {
  return (profile && profile.privacy && profile.privacy.blocklist_replace) || '<同事>'
}

function scrubOne(text, kind, re, replace) {
  let hits = 0
  const out = text.replace(re, (match, ...groups) => {
    hits++
    if (kind === 'secret_kv' && groups.length >= 2) {
      // 形如 "app_secret=xxx"：保留 key 名替 value
      const keyName = groups[0]
      return `${keyName}=<redacted:${kind}>`
    }
    return replace || `<redacted:${kind}>`
  })
  return { out, hits }
}

function text(input, profile) {
  if (typeof input !== 'string' || !input) return input
  let s = input
  const allPatterns = [
    ...PATTERNS.map(([kind, re]) => [kind, re, null]),
    ...blocklistPatterns(profile).map(([kind, re]) => [kind, re, blocklistReplace(profile)]),
  ]
  for (const [kind, re, replace] of allPatterns) {
    const r = scrubOne(s, kind, re, replace)
    s = r.out
  }
  return s
}

function detect(input, profile) {
  if (typeof input !== 'string' || !input) {
    return { hits: [], cleanText: input }
  }
  let s = input
  const hits = []
  const allPatterns = [
    ...PATTERNS.map(([kind, re]) => [kind, re, null]),
    ...blocklistPatterns(profile).map(([kind, re]) => [kind, re, blocklistReplace(profile)]),
  ]
  for (const [kind, re, replace] of allPatterns) {
    // 先抓 sample（截短 16 字符）再 scrub
    const matches = s.match(re)
    if (matches && matches.length) {
      hits.push({ kind, sample: String(matches[0]).slice(0, 16), count: matches.length })
    }
    const r = scrubOne(s, kind, re, replace)
    s = r.out
  }
  return { hits, cleanText: s }
}

// === CLI ===

function readProfile(projectRoot) {
  const file = path.join(projectRoot, '.cc-bot', 'profiles', 'active.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}  // profile 缺失也允许 scrub（内置 patterns 仍工作）
  }
}

function readStdinSync() {
  return fs.readFileSync(0, 'utf8')
}

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
    '  redact.js scrub  --project <root> [--text <s> | --stdin]',
    '  redact.js detect --project <root> [--text <s> | --stdin]',
    '',
    'scrub  → stdout: 脱敏后文本（适合 pipe）',
    'detect → stdout: {"hits":[{"kind","sample","count"}],"cleanText":"..."}',
    '',
    '内置 kinds: slack_xoxb / slack_xapp / bearer / jwt / secret_kv / lark_app_id / lark_open_id / lark_msg_id / email / phone_cn / real_name',
    'real_name 来源：profile.privacy.blocklist 数组，替换为 profile.privacy.blocklist_replace（缺省 "<同事>"）',
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
    const projectRoot = args.project || '.'
    const profile = readProfile(projectRoot)
    const input = args.stdin ? readStdinSync() : (typeof args.text === 'string' ? args.text : '')
    if (!input) throw new Error('no input (--text <s> or --stdin)')
    if (subcmd === 'scrub') {
      process.stdout.write(text(input, profile))
    } else if (subcmd === 'detect') {
      process.stdout.write(JSON.stringify(detect(input, profile)) + '\n')
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

module.exports = { text, detect, PATTERNS, blocklistPatterns }
