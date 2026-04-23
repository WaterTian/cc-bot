#!/usr/bin/env node
// cc-bot 主会话忙碌锁 — CC UserPromptSubmit/Stop hook 调用。
//
// lock   时机：主窗口用户真输入（UserPromptSubmit）
// unlock 时机：主会话响应完成（Stop）
//
// Monitor 事件注入不走 UserPromptSubmit，所以 hook 天然只在"主窗口真输入"
// 期间上锁，不会被群消息处理误触发。
//
// 用法：
//   node runtime/main-busy.js lock
//   node runtime/main-busy.js unlock
//
// 写入位置：<cwd>/.cc-bot/runtime/main-busy.lock
// hook 默认 CWD = 项目根，cc-bot 目标项目的锁落到自己 .cc-bot/ 下。
//
// 失败策略：静默 swallow（hook 崩溃会拖累主会话，得不偿失）。

const fs = require('fs')
const path = require('path')

const CCB_DIR = path.join(process.cwd(), '.cc-bot')
const CCB_RUNTIME = path.join(CCB_DIR, 'runtime')
const LOCK_FILE = path.join(CCB_RUNTIME, 'main-busy.lock')
const NOTIFIED_FLAG = path.join(CCB_RUNTIME, 'main-busy-notified.flag')

// hook 注册在用户全局 settings.json，会在所有项目触发。
// 仅在已启用 cc-bot 的项目（`.cc-bot/` 存在）里干活，避免污染其他项目。
function isCcBotProject() {
  try {
    return fs.statSync(CCB_DIR).isDirectory()
  } catch {
    return false
  }
}

function lock() {
  if (!isCcBotProject()) return
  try {
    fs.mkdirSync(CCB_RUNTIME, { recursive: true })
    const payload = {
      ts: Date.now(),
      session: process.env.CLAUDE_SESSION_ID || 'unknown',
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify(payload))
  } catch {}
}

function unlock() {
  if (!isCcBotProject()) return
  try { fs.unlinkSync(LOCK_FILE) } catch {}
  try { fs.unlinkSync(NOTIFIED_FLAG) } catch {}
}

const cmd = process.argv[2]
if (cmd === 'lock') lock()
else if (cmd === 'unlock') unlock()
// 未知参数静默退出
