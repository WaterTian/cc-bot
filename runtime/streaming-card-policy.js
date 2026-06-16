// cc-bot 流式卡片策略 — 单一事实源
//
// 之前 streaming-card.js / dispatch.js / todo-bridge.js 各自 inline 判
// `im.type==='lark' && im.streaming_card?.enabled===true`，三处必漂移。
// 抽到这里，未来给 streaming_card config 加字段（print_frequency_ms / max_payload 等）
// 也只改这一处。
//
// 故意做成无依赖的纯函数模块（不 require ./redact / ./streaming-card），让任何
// 轻量工具（如 todo-bridge hook）import 时不会拖入 cardkit / lark-cli 调用栈。

function canUseStreamingCard(profile) {
  const im = (profile && profile.im) || {}
  if (im.type !== 'lark') return { ok: false, reason: 'not-lark' }
  if (!(im.streaming_card && im.streaming_card.enabled === true)) {
    return { ok: false, reason: 'flag-off' }
  }
  return { ok: true, reason: 'lark+enabled' }
}

module.exports = { canUseStreamingCard }
