// Slack IMAdapter 实现（Socket Mode push 模式）。
//
// 依赖：@slack/web-api + @slack/socket-mode（用户安装 plugin 后由 setup 引导 npm install）。
//
// 与 lark adapter 的关键差异：
//   - lark 走 polling（poll.js 30s tick 调 listRecentMessages）
//   - slack 走 Socket Mode push（startListening 建 WS 长连接，消息推到回调）
//
// 选择 Socket Mode 而非 polling 的原因（2026-05 调研）：
//   1. Slack 2025-05-29 改革 conversations.history rate limit 到 1 req/min（非 Marketplace 新 app），
//      polling 路径用户体验崩塌
//   2. Socket Mode 是 Slack 官方推荐的"本地开发 + 防火墙后"方案，跟 cc-bot 用户场景天然匹配
//   3. Socket Mode 不消耗 history rate limit，独立 quota
//
// 三层防御对照：
//   ① PID lockfile 单例锁 — poll.js 层适用，adapter 不管
//   ② stdout EPIPE 容忍 — poll.js 层适用
//   ③ state.last_processed_time 未来值自愈 — 不适用（Socket Mode 无 last_time 概念）
//   (新) WS 断流监控 — 由 @slack/socket-mode 内部自动重连 + adapter 监听 disconnect 事件兜底

const fs = require('fs')
const path = require('path')
const https = require('https')
const { IMAdapter } = require('./base')

// 延迟 require，让没装 SDK 的用户也能 load adapters/lark.js 不报错
function loadSdks() {
  try {
    const { WebClient } = require('@slack/web-api')
    const { SocketModeClient } = require('@slack/socket-mode')
    return { WebClient, SocketModeClient }
  } catch (err) {
    throw new Error(
      'SlackAdapter: @slack/web-api / @slack/socket-mode 未安装。' +
      '在 cc-bot 插件目录跑 `npm install @slack/web-api @slack/socket-mode`'
    )
  }
}

function sanitize(s) {
  return String(s || '').replace(/[\r\n]/g, ' ')
}

// Slack ts: "1700000000.123456" → ms
function tsToMs(ts) {
  const f = parseFloat(String(ts || '0'))
  return Number.isFinite(f) ? Math.round(f * 1000) : 0
}

// 从 Slack message 文本里提取 <@U0XXX> mention 列表
function parseMentions(text) {
  const re = /<@([UW][A-Z0-9]+)>/g
  const ids = []
  let m
  while ((m = re.exec(String(text || '')))) ids.push({ id: { open_id: m[1] } })
  return ids
}

// 把 Slack message event 归一为标准 Message
function normalizeMessage(event, botUserId) {
  if (!event || !event.ts) return null
  const senderId = event.user || event.bot_id || ''
  const senderType = (senderId === botUserId || event.bot_id) ? 'bot' : 'user'

  // 类型推断：有 files 数组 → image / file，否则 text
  // content 里附带 [Image: <file_id>] / [File: <file_id>] — bot 主会话直接拿 file_id
  // 调 slack-send.js download --file-id <id>，不需要回查 conversations.history。
  // file_id（F0xxx）优先；缺失（极少）回退到 file.name 保住"有标识可用"
  let type = 'text'
  let extra = ''
  if (Array.isArray(event.files) && event.files.length > 0) {
    const first = event.files[0]
    const mime = String(first.mimetype || '')
    type = mime.startsWith('image/') ? 'image' : 'file'
    extra = ' ' + event.files.map(f => {
      const label = f.mimetype && f.mimetype.startsWith('image/') ? 'Image' : 'File'
      return `[${label}: ${f.id || f.name}]`
    }).join(' ')
  }
  const text = (event.text || '') + extra
  return {
    id: event.ts,
    senderId,
    senderType,
    type,
    content: sanitize(text),
    createTimeMs: tsToMs(event.ts),
    mentions: parseMentions(event.text),
    raw: event,
  }
}

class SlackAdapter extends IMAdapter {
  /**
   * @param {{botToken: string, appToken: string, botUserId: string}} opts
   *   botToken: xoxb-...（Web API 用）
   *   appToken: xapp-...（Socket Mode 连接用，scope: connections:write）
   *   botUserId: U0XXX（bot 在 workspace 的 user_id，用于过滤 bot 自发消息）
   */
  constructor({ botToken, appToken, botUserId } = {}) {
    super()
    if (!botToken) throw new Error('SlackAdapter: botToken required (xoxb-...)')
    if (!appToken) throw new Error('SlackAdapter: appToken required (xapp-...)')
    if (!botUserId) throw new Error('SlackAdapter: botUserId required (U0XXX)')
    this._botToken = botToken
    this._appToken = appToken
    this._botUserId = botUserId

    const { WebClient, SocketModeClient } = loadSdks()
    this._web = new WebClient(botToken)
    this._SocketModeClient = SocketModeClient
    this._sm = null

    // 设计决策：默认所有消息走 channel 主流（不进 thread）— 跟飞书行为对齐，
    // 群里开发同事人设下连续主流对话比 thread 体验顺。仅显式传 replyTo 时才用
    // thread_ts（保留 IMAdapter 接口语义：飞书 replyTo→引用框、Slack replyTo→thread）。
  }

  get botIdentity() {
    return { id: this._botUserId, name: 'cc-bot' }
  }

  // listRecentMessages 仍然可用 — 主路径走 Socket Mode push，本方法用作兜底/调试。
  // 受 2025-05-29 rate limit 改革限制（非 Marketplace 新 app: 1 req/min, ≤15 条），慎用。
  async listRecentMessages({ chatId, pageSize = 10 }) {
    if (!chatId) throw new Error('listRecentMessages: chatId required')
    const res = await this._web.conversations.history({
      channel: chatId,
      limit: Math.min(pageSize, 15),
    })
    if (!res.ok) throw new Error(`conversations.history failed: ${res.error}`)
    const raw = Array.isArray(res.messages) ? res.messages : []
    // Slack 默认降序（最新在前），与 lark 一致
    return raw.map(m => normalizeMessage(m, this._botUserId)).filter(Boolean)
  }

  /**
   * @param {{chatId: string, text: string, replyTo?: string}} opts
   *   replyTo: 显式传则进 thread（thread_ts）；不传则默认主流（跟飞书行为一致）
   */
  async sendText({ chatId, text, replyTo }) {
    if (!text) throw new Error('sendText: text required')
    if (!chatId) throw new Error('sendText: chatId required')
    const opts = { channel: chatId, text: String(text) }
    if (replyTo) opts.thread_ts = String(replyTo)
    const res = await this._web.chat.postMessage(opts)
    if (!res.ok) throw new Error(`chat.postMessage failed: ${res.error}`)
    return { id: res.ts || '' }
  }

  /**
   * @param {{chatId: string, imagePath: string, replyTo?: string}} opts
   */
  async sendImage({ chatId, imagePath, replyTo }) {
    if (!imagePath) throw new Error('sendImage: imagePath required')
    if (!chatId) throw new Error('sendImage: chatId required')
    const abs = path.resolve(imagePath)
    if (!fs.existsSync(abs)) throw new Error(`sendImage: file not found: ${abs}`)
    const opts = {
      channel_id: chatId,
      file: fs.createReadStream(abs),
      filename: path.basename(abs),
    }
    if (replyTo) opts.thread_ts = String(replyTo)
    const res = await this._web.files.uploadV2(opts)
    if (!res.ok) throw new Error(`files.uploadV2 failed: ${res.error || 'unknown'}`)
    // uploadV2 返回 { ok, files: [{id, ...}] }
    const file = (res.files && res.files[0]) || {}
    return { id: file.id || '' }
  }

  // Slack 下载文件靠 files.info 拿 url_private + Bearer token GET 二进制
  async downloadResource({ messageId, fileKey, type, output }) {
    if (!fileKey || !output) throw new Error('downloadResource: fileKey / output required')
    const info = await this._web.files.info({ file: fileKey })
    if (!info.ok) throw new Error(`files.info failed: ${info.error}`)
    const url = info.file && info.file.url_private_download
    if (!url) throw new Error(`downloadResource: no url_private_download for ${fileKey}`)
    await this._httpsDownload(url, output)
    return { path: path.resolve(output) }
  }

  _httpsDownload(url, output) {
    return new Promise((resolve, reject) => {
      const u = new URL(url)
      const req = https.get({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: { Authorization: `Bearer ${this._botToken}` },
      }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          this._httpsDownload(res.headers.location, output).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`download HTTP ${res.statusCode}`))
          res.resume()
          return
        }
        const tmp = output + '.part'
        const ws = fs.createWriteStream(tmp)
        res.pipe(ws)
        ws.on('finish', () => {
          ws.close(() => {
            try { fs.renameSync(tmp, output) } catch (e) { reject(e); return }
            resolve()
          })
        })
        ws.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout(60000, () => { req.destroy(new Error('download timeout')) })
    })
  }

  async getUser({ userId }) {
    if (!userId) throw new Error('getUser: userId required')
    const res = await this._web.users.info({ user: userId })
    if (!res.ok) throw new Error(`users.info failed: ${res.error}`)
    const u = res.user || {}
    return {
      id: u.id || userId,
      name: (u.profile && (u.profile.display_name || u.profile.real_name)) || u.name || '',
    }
  }

  // 给消息打 emoji reaction（issue #12 ack 信号）。失败返 {ok:false,reason} 不抛 —
  // poll.js 视作装饰性增强，任何失败（缺 reactions:write scope / 限流）静默降级不影响 emit。
  // chatId 必传：Slack reactions.add 需要 (channel, timestamp) 二元组。
  async addReaction({ messageId, emoji, chatId } = {}) {
    if (!messageId || !emoji || !chatId) return { ok: false, reason: 'missing-params' }
    try {
      const res = await this._web.reactions.add({
        channel: chatId,
        timestamp: String(messageId),
        name: String(emoji),
      })
      if (!res.ok) return { ok: false, reason: res.error || 'unknown' }
      return { ok: true }
    } catch (err) {
      // already_reacted：bot 已经 react 过同 emoji，视作成功（幂等语义）
      const code = err && (err.data && err.data.error || err.code || err.message) || ''
      if (String(code).includes('already_reacted')) return { ok: true }
      return { ok: false, reason: String(code).slice(0, 200) }
    }
  }

  // Push 模式核心 — Socket Mode 接事件，归一化后调 onMessage。
  // SDK 内部处理 disconnect/refresh_requested + 自动重连，断流彻底无法自愈才走 onError。
  async startListening({ chatId, onMessage, onError } = {}) {
    if (!onMessage) throw new Error('startListening: onMessage required')
    if (this._sm) throw new Error('startListening: already listening')

    const sm = new this._SocketModeClient({ appToken: this._appToken })
    this._sm = sm

    // 监听 message events（含 channel/group message）
    sm.on('message', async ({ event, ack }) => {
      try { await ack() } catch {}
      try {
        // chatId 守卫：只 emit 配置 channel 的消息（避免 bot 加多个群时跨群污染）
        if (chatId && event && event.channel && event.channel !== chatId) return
        // 子类型守卫：忽略 channel_join / message_changed / message_deleted 等
        if (event && event.subtype && event.subtype !== 'file_share') return
        const m = normalizeMessage(event, this._botUserId)
        if (!m) return
        onMessage(m)
      } catch (err) {
        if (onError) onError(err)
      }
    })

    // app_mention 单独处理：当 bot 被 @ 时 Slack 同时发 message 和 app_mention，
    // 我们以 message 事件为准（含完整 channel/text/files），app_mention 仅 ack 不重复 emit
    sm.on('app_mention', async ({ ack }) => { try { await ack() } catch {} })

    sm.on('error', (err) => { if (onError) onError(err) })
    sm.on('disconnect', () => {
      // SDK 会自动尝试重连，这里只观察不动作
    })

    await sm.start()
  }

  async stopListening() {
    if (!this._sm) return
    try { await this._sm.disconnect() } catch {}
    this._sm = null
  }
}

module.exports = { SlackAdapter }
