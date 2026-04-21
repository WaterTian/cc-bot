#!/usr/bin/env node
// cc-bot statusline shim — 由 Claude Code 的 statusLine hook 每 tick 触发。
//
// 职责：
//   ① 把 CC 注入的 stdin JSON 落盘到 <project-root>/.cc-bot/runtime/hud-stdin.json
//      供 cc-bot 在群里回答 HUD 意图、上线通知拼接模型/上下文时读取
//   ② 若机器上装了 cc-hud（独立 statusline 渲染器），把同份 stdin 透传给它
//      并把 cc-hud 的 stdout 原样输出到本进程 stdout（= CC 状态栏内容）
//   ③ 未装 cc-hud 时沉默输出空字符串，不干扰状态栏
//
// 设计原则：
//   - 失败永远不抛到 stdout/stderr 以外（状态栏挂掉会惹用户烦）
//   - 所有 I/O 都 try/catch，任何异常降级为"空状态栏 + 无落盘"
//   - 同步调用 cc-hud（CC 等 statusLine 同步返回），加 3s 超时兜底
//   - project root 解析顺序：env CLAUDE_PROJECT_DIR → stdin JSON.cwd → 跳过落盘

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const CC_HUD_TIMEOUT_MS = 3000

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function resolveProjectRoot(raw) {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR
  try {
    const j = JSON.parse(raw)
    if (j && typeof j.cwd === 'string') return j.cwd
  } catch {}
  return null
}

function writeHudStdin(projectRoot, raw) {
  if (!projectRoot || !raw) return
  try {
    // 只在已初始化 cc-bot 的项目里落盘，避免污染非 cc-bot 项目
    const ccbotDir = path.join(projectRoot, '.cc-bot')
    if (!fs.existsSync(ccbotDir)) return
    const outDir = path.join(ccbotDir, 'runtime')
    const outPath = path.join(outDir, 'hud-stdin.json')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(outPath, raw, 'utf8')
  } catch {}
}

function findCcHudEntry() {
  try {
    const pluginsFile = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json')
    const data = JSON.parse(fs.readFileSync(pluginsFile, 'utf8'))
    const entries = (data && data.plugins) || {}
    for (const [key, arr] of Object.entries(entries)) {
      if (!key.startsWith('cc-hud@')) continue
      if (!Array.isArray(arr) || !arr[0]) continue
      const install = arr[0].installPath
      if (!install) continue
      const entry = path.join(install, 'dist', 'index.js')
      if (fs.existsSync(entry)) return entry
    }
  } catch {}
  return null
}

function renderViaCcHud(entry, raw) {
  try {
    const res = spawnSync(process.execPath, [entry], {
      input: raw,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CC_HUD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    if (res && typeof res.stdout === 'string') return res.stdout
  } catch {}
  return ''
}

function main() {
  const raw = readStdinSync()
  const projectRoot = resolveProjectRoot(raw)
  writeHudStdin(projectRoot, raw)

  const entry = findCcHudEntry()
  if (entry) {
    const out = renderViaCcHud(entry, raw)
    if (out) process.stdout.write(out)
  }
  // 没装 cc-hud：不输出，状态栏空（CC 默认）
}

process.on('uncaughtException', () => {})
process.on('unhandledRejection', () => {})

main()
