// IMAdapter 工厂 — 按 profile.im.type 实例化 adapter。
//
// 被 runtime/poll.js（消息主进程）和 runtime/permission-bridge.js（权限转群 hook）共用：
// 同一份「字段齐不齐 / 用哪个实现」判定只写一处（single-source，见 memory code-driven 原则 6）。
//
// 失败抛 Error，并带 err.code ∈ 'profile-missing' | 'profile-invalid' | 'unsupported-im' | 'adapter-init'，
// 调用方据此拼 BOT_ERROR 行（poll.js）或静默退出（hook）。

const path = require('path')

function tagged(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * @param {object} profile  .cc-bot/profiles/active.json 内容
 * @returns {import('./base').IMAdapter}
 */
function createAdapter(profile) {
  const im = profile && profile.im
  if (!im || !im.type) throw tagged('profile-missing', 'profile 缺失或缺 im.type')
  try {
    if (im.type === 'lark') {
      if (!im.bot_app_id || !im.chat_id) throw tagged('profile-invalid', 'lark 需要 im.bot_app_id 和 im.chat_id')
      const { LarkAdapter } = require(path.join(__dirname, 'lark'))
      return new LarkAdapter({ botAppId: im.bot_app_id })
    }
    if (im.type === 'slack') {
      const extra = im.extra || {}
      if (!extra.bot_token || !extra.app_token || !im.bot_user_id || !im.chat_id) {
        throw tagged('profile-invalid', 'slack 需要 im.extra.bot_token / im.extra.app_token / im.bot_user_id / im.chat_id')
      }
      const { SlackAdapter } = require(path.join(__dirname, 'slack'))
      return new SlackAdapter({ botToken: extra.bot_token, appToken: extra.app_token, botUserId: im.bot_user_id })
    }
  } catch (err) {
    if (err && err.code) throw err
    throw tagged('adapter-init', (err && err.message) || String(err))
  }
  throw tagged('unsupported-im', `im.type=${im.type} 暂不支持`)
}

// locale 决策（与 poll.js / quota-alert.js 同规则）：profile 显式优先 → 按 IM 类型默认 → 兜底 zh-CN
const DEFAULT_LOCALE_BY_IM = { lark: 'zh-CN', slack: 'en-US' }
function resolveLocale(profile) {
  const im = (profile && profile.im) || {}
  return im.locale || DEFAULT_LOCALE_BY_IM[im.type] || 'zh-CN'
}

module.exports = { createAdapter, resolveLocale, DEFAULT_LOCALE_BY_IM }
