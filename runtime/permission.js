#!/usr/bin/env node
// cc-bot 权限判定（lark / slack 通用）
//
// 把 SKILL.md §权限矩阵 + §角色判定从 prose 移到代码，每条群消息派工前调一次，
// LLM 不再读权限表 prose。
//
// 接口：
//   permission.check({ senderOpenId, intentKey, profile })
//     → { decision, role, level, reason }
//   permission.knownIntentLevels()  → built-in intent 的 level 表（供 doctor / debug）
//
// CLI 模式（给主会话 Bash 调）：
//   node runtime/permission.js check --project <root> --sender <ou_xxx> --intent <key>
//     → stdout JSON: {decision, role, level, reason}
//
// 内置 intent 的 level（cc-bot 自带的通用意图）：
//   hud / help / query_progress / query_todo / visual_bug_report → public
//   bot_switch                                                  → group-rejected
//
// project-level 自定义 intent（profile.intents.<key>）的 level：
//   profile.intent_permissions[key] 显式声明（'public' / 'admin' / 'admin-confirm'）→ 用它
//   未声明 → 默认 'public'
//
// decision 含义：
//   allow            → 直接执行
//   confirm-needed   → 写 pending_confirm 等用户回"Y/确认"
//   reject           → 直接拒绝，给 reason 文案让 LLM 回群
//   group-rejected   → 该 intent 不接受来自群的指令（如开关 bot），回固定文案

const fs = require('fs')
const path = require('path')

// 内置意图等级表
const BUILTIN_LEVELS = Object.freeze({
  hud: 'public',
  help: 'public',
  query_progress: 'public',
  query_todo: 'public',
  visual_bug_report: 'public',
  unknown: 'public',  // 落 unknown 时让流程继续，由 LLM 回"无法识别"
  bot_switch: 'group-rejected',
})

const VALID_LEVELS = new Set(['public', 'admin', 'admin-confirm', 'group-rejected'])

// 防御启发式：intent 名匹配高危关键词 → 默认 'admin'，避免 legacy profile（无 intent_permissions）
// 把生产部署类操作意外公开给非 admin 成员。用户可 override 为 'public' 显式声明放开。
const HIGH_RISK_NAME_PATTERNS = [
  /^deploy/i, /^publish/i, /^release/i, /^push_to_/i,
  /^drop_/i, /^delete_/i, /^remove_/i, /^reset_/i,
  /^restart_/i, /^kill_/i, /^purge_/i, /^prod/i,
  /-deploy$/i, /-publish$/i, /-prod$/i,
]

function isHighRiskName(intentKey) {
  return HIGH_RISK_NAME_PATTERNS.some(re => re.test(intentKey))
}

function levelFor(intentKey, profile) {
  if (BUILTIN_LEVELS[intentKey]) return BUILTIN_LEVELS[intentKey]
  const perm = profile && profile.intent_permissions && profile.intent_permissions[intentKey]
  if (perm && VALID_LEVELS.has(perm)) return perm
  // 未显式声明 + 名字高危 → 默认 admin（安全兜底）
  if (isHighRiskName(intentKey)) return 'admin'
  return 'public'
}

function roleFor(senderOpenId, profile) {
  const admins = (profile && profile.members && profile.members.admin_open_ids) || []
  return admins.includes(senderOpenId) ? 'admin' : 'member'
}

function check({ senderOpenId, intentKey, profile }) {
  if (!profile) throw new Error('permission.check: profile required')
  if (!intentKey) throw new Error('permission.check: intentKey required')
  const role = roleFor(senderOpenId, profile)
  const level = levelFor(intentKey, profile)

  // group-rejected：bot_switch 等，群里发一律拒
  if (level === 'group-rejected') {
    return {
      decision: 'group-rejected',
      role, level,
      reason: '该操作不接受来自群的指令（如 bot 开关请在 Claude Code 主会话发起）',
    }
  }

  // public：任何人可用
  if (level === 'public') {
    return { decision: 'allow', role, level, reason: 'public intent, anyone allowed' }
  }

  // admin / admin-confirm：member 一律拒
  if (role === 'member') {
    return {
      decision: 'reject',
      role, level,
      reason: '该操作需要管理员授权',
    }
  }

  // admin + admin-auto → 直接执行，不写 pending_confirm
  if (level === 'admin') {
    return { decision: 'allow', role, level, reason: 'admin auto-approved' }
  }

  // admin + admin-confirm → 仍需口头确认一次
  if (level === 'admin-confirm') {
    return {
      decision: 'confirm-needed',
      role, level,
      reason: '即使 admin 也需口头确认（破坏性操作）',
    }
  }

  // unreachable
  return { decision: 'reject', role, level, reason: 'unknown permission level' }
}

function knownIntentLevels() {
  return Object.assign({}, BUILTIN_LEVELS)
}

// === CLI ===

function readProfile(projectRoot) {
  const file = path.join(projectRoot, '.cc-bot', 'profiles', 'active.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`profile read failed (${file}): ${e.message}`)
  }
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
    '  permission.js check --project <root> --sender <ou_xxx> --intent <key>',
    '  permission.js levels                                          # dump built-in level table',
    '',
    'Output (check):',
    '  {"decision":"allow|reject|confirm-needed|group-rejected", "role":"admin|member", "level":"...", "reason":"..."}',
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
    if (subcmd === 'check') {
      if (!args.project) throw new Error('--project required')
      if (!args.intent) throw new Error('--intent required')
      const profile = readProfile(args.project)
      const sender = args.sender || ''   // 可空，空 = member（保守）
      const result = check({ senderOpenId: sender, intentKey: args.intent, profile })
      process.stdout.write(JSON.stringify(result) + '\n')
    } else if (subcmd === 'levels') {
      process.stdout.write(JSON.stringify(knownIntentLevels(), null, 2) + '\n')
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

module.exports = { check, knownIntentLevels, levelFor, roleFor, isHighRiskName, BUILTIN_LEVELS, VALID_LEVELS, HIGH_RISK_NAME_PATTERNS }
