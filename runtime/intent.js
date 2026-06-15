#!/usr/bin/env node
// cc-bot intent 解析（lark / slack 通用）
//
// 把 SKILL.md §占位符约定 + §帮助动态筛选规则 + §通用意图表（部分）从 prose 移到代码。
// LLM 仍然负责"用户自然语言消息匹配哪个 intent key"的语义判断，
// 但占位符替换 / 动态可用清单 / 校验 key 是否存在等纯数据逻辑全部交给本模块。
//
// 接口：
//   intent.resolveAction(intentKey, profile)
//     → { found: bool, description: string|null, source: 'builtin'|'project'|null }
//   intent.listAvailable(profile)
//     → [{ key, hint, source }]
//   intent.knownKeys(profile)  → [keys]
//
// CLI 模式（给主会话 Bash 调）：
//   node runtime/intent.js resolve --project <root> --key <intentKey>
//   node runtime/intent.js list    --project <root>
//   node runtime/intent.js keys    --project <root>
//
// 占位符替换规则：
//   <project.root>          → profile.project.root
//   <project.doc_progress>  → 拼成绝对路径
//   <paths.bot_temp_abs>    → profile.paths.bot_temp_abs
//   <paths.bot_temp_rel>    → profile.paths.bot_temp_rel
//   <chat_id>               → profile.im.chat_id
//   <bot_app_id>            → profile.im.bot_app_id
// （未来加占位符直接改本模块，不用动 SKILL.md）

const fs = require('fs')
const path = require('path')

// 内置意图描述（与 permission.js 的 BUILTIN_LEVELS 配对）
const BUILTIN_INTENTS = Object.freeze({
  hud:                { hint: '查 bot 当前会话状态（模型、上下文用量）' },
  help:               { hint: '列出当前 profile 可用的操作清单' },
  query_progress:     { hint: '读项目进度文档摘要' },
  query_todo:         { hint: '从进度文档抽未完成项' },
  visual_bug_report:  { hint: '处理「文字 + 截图」的 bug 反馈' },
  // bot_switch / unknown 不进 help 清单（前者群里被拒，后者是 fallback）
})

function substitute(s, profile) {
  if (typeof s !== 'string') return s
  const im = (profile && profile.im) || {}
  const proj = (profile && profile.project) || {}
  const paths = (profile && profile.paths) || {}
  let docProgressAbs = ''
  if (proj.root && proj.doc_progress) {
    docProgressAbs = path.join(proj.root, proj.doc_progress)
  }
  return s
    .replace(/<project\.root>/g, proj.root || '')
    .replace(/<project\.doc_progress>/g, docProgressAbs)
    .replace(/<paths\.bot_temp_abs>/g, paths.bot_temp_abs || '')
    .replace(/<paths\.bot_temp_rel>/g, paths.bot_temp_rel || '')
    .replace(/<chat_id>/g, im.chat_id || '')
    .replace(/<bot_app_id>/g, im.bot_app_id || '')
}

function resolveAction(intentKey, profile) {
  if (!intentKey) return { found: false, description: null, source: null }
  // 内置 intent：返回 hint 当 description（hint 已经是动作描述）
  if (BUILTIN_INTENTS[intentKey]) {
    return {
      found: true,
      description: substitute(BUILTIN_INTENTS[intentKey].hint, profile),
      source: 'builtin',
    }
  }
  // project intent
  const intents = (profile && profile.intents) || {}
  const raw = intents[intentKey]
  if (typeof raw === 'string' && raw.trim() && !raw.startsWith('_')) {
    return { found: true, description: substitute(raw, profile), source: 'project' }
  }
  return { found: false, description: null, source: null }
}

function hasDocProgress(profile) {
  const proj = (profile && profile.project) || {}
  if (!proj.root || !proj.doc_progress) return false
  try {
    const abs = path.join(proj.root, proj.doc_progress)
    return fs.statSync(abs).isFile()
  } catch {
    return false
  }
}

function listAvailable(profile) {
  const out = []
  // 永久可用
  out.push({ key: 'hud', hint: BUILTIN_INTENTS.hud.hint, source: 'builtin' })
  out.push({ key: 'help', hint: BUILTIN_INTENTS.help.hint, source: 'builtin' })

  // 条件可用：doc_progress 配置且文件存在
  if (hasDocProgress(profile)) {
    out.push({ key: 'query_progress', hint: BUILTIN_INTENTS.query_progress.hint, source: 'builtin' })
    out.push({ key: 'query_todo', hint: BUILTIN_INTENTS.query_todo.hint, source: 'builtin' })
  }

  // project intents：非空 string + 非 _comment 字段
  const intents = (profile && profile.intents) || {}
  for (const key of Object.keys(intents)) {
    if (key.startsWith('_')) continue
    const raw = intents[key]
    if (typeof raw !== 'string' || !raw.trim()) continue
    // hint = description 的第一句（截短到 60 字）
    const first = String(raw).split(/[。\.\n]/)[0].slice(0, 60)
    out.push({ key, hint: substitute(first, profile), source: 'project' })
  }

  return out
}

function knownKeys(profile) {
  const builtin = Object.keys(BUILTIN_INTENTS)
  const proj = Object.keys((profile && profile.intents) || {}).filter(k => !k.startsWith('_'))
  return Array.from(new Set([...builtin, ...proj]))
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
    '  intent.js resolve --project <root> --key <intentKey>',
    '  intent.js list    --project <root>',
    '  intent.js keys    --project <root>',
    '',
    'Output:',
    '  resolve → {"found":true|false, "description":"<已替换占位符>", "source":"builtin|project"|null}',
    '  list    → {"items":[{"key":"...","hint":"...","source":"..."}, ...]}',
    '  keys    → {"keys":["hud","help","query_progress",...]}',
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
    const profile = readProfile(args.project)
    if (subcmd === 'resolve') {
      if (!args.key) throw new Error('--key required')
      process.stdout.write(JSON.stringify(resolveAction(args.key, profile)) + '\n')
    } else if (subcmd === 'list') {
      process.stdout.write(JSON.stringify({ items: listAvailable(profile) }) + '\n')
    } else if (subcmd === 'keys') {
      process.stdout.write(JSON.stringify({ keys: knownKeys(profile) }) + '\n')
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
  resolveAction, listAvailable, knownKeys,
  substitute, hasDocProgress,
  BUILTIN_INTENTS,
}
