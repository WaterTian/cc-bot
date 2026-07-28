#!/usr/bin/env node
// cc-bot profile schema 版本化迁移
//
// 用户从老版本（如 v0.1.18）升 cc-bot 到新版（v0.1.28+）时，已有的 profile/active.json
// 缺最近几版加的字段（busy_placeholder / streaming_card / privacy 等）。setup.md §幂等重入
// 只补 settings.json hooks 不补 profile 字段；poll.js 缺字段 fallback 到默认值但用户不知道
// 字段可调。本工具版本化补全 missing 字段，**绝不覆盖 existing 值**（包括用户自定义注释）。
//
// CLI 模式：
//   profile-migrate.js apply --project <root>   # 写盘 backfill
//   profile-migrate.js check --project <root>   # dry-run，列 missing
//
// 设计：
//   - 每条 migration 记录某版本的新增字段 + 它的默认值
//   - 顺序跑全部 migration，每条幂等（key 存在 → 跳过；不存在 → 写默认）
//   - 嵌套字段（如 im.streaming_card.short_threshold）也补
//   - 不删字段、不改字段类型、不覆盖任何 existing 值
//   - 新版本加字段时往本表追加，不动旧条目
//
// 加新 migration 流程：
//   1. 新版本 release 加字段时，本表 push 一条 { version, path, default }
//   2. setup.md 入口 / doctor §2 已自动覆盖，无需改文档

const fs = require('fs')
const path = require('path')
const { atomicWriteSync } = require('./atomic-write')

// 历史 migration（顺序追加，不删除已发布条目）。
// path 用 . 表示嵌套层级；细粒度到每个字段，方便用户半 migrate 半改后再升时不漏补内部字段。
// 嵌套字段：父 path 先创空块，子 path 再补内部字段（hasPath 检查每层都得存在）。
const MIGRATIONS = [
  { version: '0.1.16', path: 'im.locale',                          default: '' },
  { version: '0.1.19', path: 'im.busy_placeholder',                default: true },
  { version: '0.1.20', path: 'im.debug',                           default: false },
  { version: '0.1.21', path: 'im.busy_reaction',                   default: '' },
  { version: '0.1.22', path: 'im.streaming_card',                  default: {} },
  { version: '0.1.22', path: 'im.streaming_card.enabled',          default: false },
  { version: '0.1.23', path: 'intent_permissions',                 default: {} },
  { version: '0.1.24', path: 'privacy',                            default: {} },
  { version: '0.1.24', path: 'privacy.blocklist',                  default: [] },
  { version: '0.1.24', path: 'privacy.blocklist_replace',          default: '<同事>' },
  { version: '0.1.37', path: 'dispatch',                           default: {} },
  { version: '0.1.37', path: 'dispatch.max_turn_time_mins',        default: 0 },
  { version: '0.1.47', path: 'quota_alert',                        default: {} },
  { version: '0.1.47', path: 'quota_alert.enabled',                default: true },
  { version: '0.1.47', path: 'quota_alert.five_hour',              default: {} },
  { version: '0.1.47', path: 'quota_alert.five_hour.warn_at',      default: 85 },
  { version: '0.1.47', path: 'quota_alert.five_hour.urgent_at',    default: 95 },
  { version: '0.1.47', path: 'quota_alert.notify_recovered',       default: true },
  { version: '0.1.47', path: 'quota_alert.hold_messages_when_exhausted', default: true },
  // v0.1.27 曾加 im.streaming_card.short_threshold=100；v0.1.30 改为换行判据，字段不再被读取。
  // migration 移除——老 profile 留着此字段无害（代码不读），新 profile 不再 backfill。
]

function getPath(obj, dotPath) {
  const parts = dotPath.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[p]
  }
  return cur
}

function hasPath(obj, dotPath) {
  const parts = dotPath.split('.')
  let cur = obj
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || typeof cur !== 'object') return false
    if (!Object.prototype.hasOwnProperty.call(cur, parts[i])) return false
    cur = cur[parts[i]]
  }
  return true
}

function setPath(obj, dotPath, value) {
  const parts = dotPath.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined || cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') {
      cur[parts[i]] = {}
    }
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = JSON.parse(JSON.stringify(value))  // deep clone
}

function check(profile) {
  const missing = []
  for (const m of MIGRATIONS) {
    if (!hasPath(profile, m.path)) {
      missing.push({ version: m.version, path: m.path, default: m.default })
    }
  }
  return missing
}

function apply(profile) {
  const added = []
  for (const m of MIGRATIONS) {
    if (!hasPath(profile, m.path)) {
      setPath(profile, m.path, m.default)
      added.push({ version: m.version, path: m.path })
    }
  }
  return added
}

// === IO ===

function profilePath(projectRoot) {
  return path.join(projectRoot, '.cc-bot', 'profiles', 'active.json')
}

function readProfile(projectRoot) {
  const f = profilePath(projectRoot)
  if (!fs.existsSync(f)) throw new Error(`profile not found: ${f}`)
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch (e) {
    throw new Error(`profile read failed (${f}): ${e.message}`)
  }
}

function writeProfile(projectRoot, profile) {
  atomicWriteSync(profilePath(projectRoot), JSON.stringify(profile, null, 2) + '\n')
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
    '  profile-migrate.js apply --project <root>   # 写盘 backfill 缺失字段',
    '  profile-migrate.js check --project <root>   # dry-run 列 missing',
    '',
    'Output:',
    '  apply → {"added":[{version, path}, ...], "count": N, "kept": existing-not-touched}',
    '  check → {"missing":[{version, path, default}, ...], "count": N}',
    '',
    '幂等：existing 值不动，仅补缺失字段；可重复跑无副作用。',
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
    if (subcmd === 'check') {
      const missing = check(profile)
      process.stdout.write(JSON.stringify({ missing, count: missing.length }) + '\n')
    } else if (subcmd === 'apply') {
      const added = apply(profile)
      if (added.length > 0) writeProfile(args.project, profile)
      process.stdout.write(JSON.stringify({ added, count: added.length }) + '\n')
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
  MIGRATIONS,
  check, apply,
  hasPath, getPath, setPath,
  readProfile, writeProfile,
}
