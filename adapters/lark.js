// 飞书（Lark）IMAdapter 实现。
//
// 外部依赖：`lark-cli` 已在 PATH、已 `auth login`（bot + user 身份）。
// 所有子命令都强制 LARK_CLI_NO_PROXY=1，规避 vpn 代理下 WS/HTTPS 静默断流问题。
//
// 跨平台：统一通过 bash 作为 shell 执行（Windows 借 Git Bash，macOS/Linux 系统自带）。
// 用裸 `lark-cli` 名 + bash 解析 PATH 找到对应可执行（Windows: lark-cli.cmd / Unix: lark-cli），
// 避开 Node 20+ spawn 不再自动解析 .cmd 扩展、且 npm batch shim 处理特殊字符不安全的问题。

const { execSync } = require('child_process')
const path = require('path')
const { IMAdapter } = require('./base')

// 统一用 bash 作为 shell（Windows 借 Git Bash 的 sh shim，用 "$@" 安全传 argv）。
// 绝不用 lark-cli.cmd — npm batch shim 的 %* 在遇到 & | % " 等字符时会损坏参数。
const LARK_BIN = 'lark-cli'
const DEFAULT_TIMEOUT_MS = 15 * 1000

// 统一走 bash 作为 shell（Windows 借 Git Bash），避开 cmd.exe 对命令行 \n / 裸 " 的粗暴解析。
// POSIX 单引号 quoting：内部字符全字面，' → '\''。JSON 字符串里不会出现 '，安全。
function quoteArg(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function parseCreateTimeMs(s) {
  // 飞书返回 "YYYY-MM-DD HH:MM:SS"（CST）
  const ts = Date.parse(String(s || '').replace(' ', 'T') + '+08:00')
  return Number.isFinite(ts) ? ts : 0
}

function sanitize(s) {
  return String(s || '').replace(/[\r\n]/g, ' ')
}

class LarkAdapter extends IMAdapter {
  /**
   * @param {{botAppId: string}} opts
   */
  constructor({ botAppId } = {}) {
    super()
    if (!botAppId) throw new Error('LarkAdapter: botAppId required')
    this._botAppId = botAppId
  }

  get botIdentity() {
    return { id: this._botAppId }
  }

  _run(args, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    const env = { ...process.env, LARK_CLI_NO_PROXY: '1' }
    const cmd = [LARK_BIN, ...args.map(quoteArg)].join(' ')
    try {
      return execSync(cmd, {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout,
        shell: 'bash',
      })
    } catch (err) {
      const stderr = err.stderr ? String(err.stderr).trim() : ''
      const stdout = err.stdout ? String(err.stdout).trim() : ''
      const detail = stderr || stdout
      throw new Error(`lark-cli failed [${args.slice(0, 3).join(' ')}]: ${err.message}${detail ? ' | ' + detail.slice(0, 500) : ''}`)
    }
  }

  _parseJson(out) {
    // lark-cli 偶尔在 stdout 头部有 proxy warning（非 JSON），取第一个 '{' 起
    const i = out.indexOf('{')
    const body = i >= 0 ? out.slice(i) : out
    try {
      return JSON.parse(body)
    } catch {
      throw new Error(`lark-cli output not JSON: ${out.slice(0, 200)}`)
    }
  }

  async listRecentMessages({ chatId, pageSize = 10 }) {
    if (!chatId) throw new Error('listRecentMessages: chatId required')
    const out = this._run([
      'im', '+chat-messages-list',
      '--as', 'bot',
      '--chat-id', chatId,
      '--page-size', String(pageSize),
      '--sort', 'desc',
    ])
    const json = this._parseJson(out)
    const raw = (json && json.data && json.data.messages) || []
    return raw
      .filter(m => m && m.message_id)
      .map(m => {
        const senderId = (m.sender && m.sender.id) || ''
        return {
          id: m.message_id,
          senderId,
          senderType: senderId === this._botAppId ? 'bot' : 'user',
          type: m.msg_type,
          content: sanitize(m.content),
          createTimeMs: parseCreateTimeMs(m.create_time),
          mentions: Array.isArray(m.mentions) ? m.mentions : [],
          raw: m,
        }
      })
  }

  async sendText({ chatId, text, replyTo }) {
    if (!text) throw new Error('sendText: text required')
    if (!replyTo && !chatId) throw new Error('sendText: chatId or replyTo required')
    // 用 --content JSON 传 text，避开 Windows cmd.exe /c 命令行遇 \n 截断的坑。
    // JSON 里的 \n 是两字符转义，不会被 shell 截断；lark-cli JSON.parse 后还原真实换行。
    const contentJson = JSON.stringify({ text })
    const args = replyTo
      ? ['im', '+messages-reply', '--as', 'bot', '--message-id', replyTo, '--msg-type', 'text', '--content', contentJson]
      : ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--msg-type', 'text', '--content', contentJson]
    const out = this._run(args)
    const json = this._parseJson(out)
    return { id: (json && json.data && json.data.message_id) || '' }
  }

  async sendImage({ chatId, imagePath, replyTo }) {
    if (!imagePath) throw new Error('sendImage: imagePath required')
    const args = replyTo
      ? ['im', '+messages-reply', '--as', 'bot', '--message-id', replyTo, '--image', imagePath]
      : ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--image', imagePath]
    if (!replyTo && !chatId) throw new Error('sendImage: chatId or replyTo required')
    const out = this._run(args)
    const json = this._parseJson(out)
    return { id: (json && json.data && json.data.message_id) || '' }
  }

  async downloadResource({ messageId, fileKey, type, output }) {
    if (!messageId || !fileKey || !type || !output) {
      throw new Error('downloadResource: messageId / fileKey / type / output required')
    }
    this._run([
      'im', '+messages-resources-download',
      '--as', 'bot',
      '--message-id', messageId,
      '--file-key', fileKey,
      '--type', type,
      '--output', output,
    ], { timeout: 60 * 1000 })
    return { path: path.resolve(output) }
  }

  // 给消息打 emoji reaction（issue #12 ack 信号）。失败返 {ok:false,reason} 不抛 —
  // poll.js 视作装饰性增强，任何失败（缺 scope / lark-cli 抖动）静默降级不影响 emit。
  async addReaction({ messageId, emoji }) {
    if (!messageId || !emoji) return { ok: false, reason: 'missing-params' }
    try {
      const params = JSON.stringify({ message_id: messageId })
      const data = JSON.stringify({ reaction_type: { emoji_type: String(emoji) } })
      const out = this._run([
        'im', 'reactions', 'create',
        '--as', 'bot',
        '--params', params,
        '--data', data,
      ], { timeout: 10 * 1000 })
      const json = this._parseJson(out)
      const reactionId = (json && json.data && json.data.reaction_id) || ''
      // lark-cli 顶层有 code 字段，非 0 视为业务失败（如 emoji_type 非法 / scope 缺）
      if (json && typeof json.code === 'number' && json.code !== 0) {
        return { ok: false, reason: `lark-code-${json.code}` }
      }
      return { ok: true, reactionId }
    } catch (err) {
      return { ok: false, reason: (err && err.message || String(err)).slice(0, 200) }
    }
  }

  async getUser({ userId }) {
    if (!userId) throw new Error('getUser: userId required')
    const out = this._run(['contact', '+get-user', '--as', 'user', '--user-id', userId])
    const json = this._parseJson(out)
    const u = (json && json.data && json.data.user) || {}
    return {
      id: u.open_id || userId,
      name: u.name || u.en_name || '',
    }
  }
}

module.exports = { LarkAdapter }
