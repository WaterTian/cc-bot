// 飞书（Lark）IMAdapter 实现。
//
// 外部依赖：`lark-cli` 已在 PATH、已 `auth login`（bot + user 身份）。
// 所有子命令都强制 LARK_CLI_NO_PROXY=1，规避 vpn 代理下 WS/HTTPS 静默断流问题。
//
// 跨平台：统一通过 bash 作为 shell 执行（Windows 借 Git Bash，macOS/Linux 系统自带）。
// 用裸 `lark-cli` 名 + bash 解析 PATH 找到对应可执行（Windows: lark-cli.cmd / Unix: lark-cli），
// 避开 Node 20+ spawn 不再自动解析 .cmd 扩展、且 npm batch shim 处理特殊字符不安全的问题。

const { execSync, spawn } = require('child_process')
const path = require('path')
const readline = require('readline')
const { IMAdapter } = require('./base')

// 统一用 bash 作为 shell（Windows 借 Git Bash 的 sh shim，用 "$@" 安全传 argv）。
// 绝不用 lark-cli.cmd — npm batch shim 的 %* 在遇到 & | % " 等字符时会损坏参数。
const LARK_BIN = 'lark-cli'
const DEFAULT_TIMEOUT_MS = 15 * 1000

// ---- 事件长连接（push transport，issue #23 Phase 3）----
// `lark-cli event consume im.message.receive_v1 --as bot` 是一条 NDJSON 子进程：
//   stderr 先出 `[event] ready event_key=...` 再开始往 stdout 吐事件；
//   启动失败在 stderr 给结构化 JSON envelope（{ok:false,error:{type,subtype,message,hint}}）；
//   无界运行以 stdin EOF 作优雅退出信号（父进程死 → 管道断 → 子进程自己退，不留孤儿）。
// 事件订阅**不计飞书 API 配额**，空闲零成本；polling 每 tick 至少 1 计费调用。
const EVENT_KEY = 'im.message.receive_v1'
const READY_RE = /\[event\] ready/
const READY_TIMEOUT_MS = 30 * 1000
const STOP_GRACE_MS = 3 * 1000
// 重连退避：5s → 10s → 20s → 40s → 60s（封顶）；连续 5 次起不来视为本轮 push 不可用
const RECONNECT_BASE_MS = 5 * 1000
const RECONNECT_MAX_MS = 60 * 1000
const RECONNECT_MAX_ATTEMPTS = 5
// 这两类 envelope 是「环境不满足」而非瞬时故障：另一台机器占着事件总线 / 缺 scope / 未登录。
// 重试无意义，直接判 fatal 让 poll.js 回落 polling。
const FATAL_ERROR_TYPES = new Set(['validation', 'auth'])

// 统一走 bash 作为 shell（Windows 借 Git Bash），避开 cmd.exe 对命令行 \n / 裸 " 的粗暴解析。
// POSIX 单引号 quoting：内部字符全字面，' → '\''。JSON 字符串里不会出现 '，安全。
function quoteArg(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function parseCreateTimeMs(s) {
  // 【降级兜底路径】lark-cli `+chat-messages-list` 把 create_time 渲染成「主机本地时区」
  // 的墙钟串（形如 "YYYY-MM-DD HH:MM"，无秒），并非固定北京时间。故不加任何固定偏移，
  // 按主机本地时区解析 —— 与 lark-cli 渲染自洽，在任意时区主机上都得到正确绝对时刻。
  // （曾硬编码 +08:00，非北京时区主机上会整体偏移导致 poll.js 时间游标静默丢消息，见 issue #21。）
  // 正常路径由 _fetchCreateTimeEpochs 取飞书原始 epoch（时区无关 + 满毫秒精度）覆盖本值，
  // 仅当 raw 端点不可用时才回落到这里。
  const ts = Date.parse(String(s || '').replace(' ', 'T'))
  return Number.isFinite(ts) ? ts : 0
}

function sanitize(s) {
  return String(s || '').replace(/[\r\n]/g, ' ')
}

// 归一 mentions 到 `{ id: { open_id }, name, key }` —— 对齐 slack adapter + poll.js `isAtOthers`
// 期望的形状（base.js Message 契约）。lark-cli 返回 `mentions[].id` 是**裸串** "ou_..."（issue #22），
// 若原样透传，poll.js 判 `mt.id.open_id` 恒 undefined → 精准 @bot 检测失效、@bot 消息被当 @他人静默 skip。
function normalizeMentions(mentions) {
  if (!Array.isArray(mentions)) return []
  return mentions
    .filter(mt => mt && mt.id)
    .map(mt => {
      const openId = typeof mt.id === 'string' ? mt.id : (mt.id.open_id || '')
      return { ...mt, id: { open_id: openId } }
    })
}

// 从 consume 子进程的 stderr 文本里抠结构化错误 envelope；抠不到返回 null。
function parseErrorEnvelope(stderrText) {
  const txt = String(stderrText || '')
  const i = txt.indexOf('{')
  const j = txt.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try {
    const json = JSON.parse(txt.slice(i, j + 1))
    if (json && json.ok === false && json.error) return json.error
  } catch {}
  return null
}

// 从 stderr 的 `[event] exited — ... (reason: xxx)` 行取退出原因
function parseExitReason(stderrText) {
  const m = /\(reason:\s*([a-z_-]+)\)/i.exec(String(stderrText || ''))
  return m ? m[1] : ''
}

class LarkAdapter extends IMAdapter {
  /**
   * @param {{botAppId: string}} opts
   */
  constructor({ botAppId } = {}) {
    super()
    if (!botAppId) throw new Error('LarkAdapter: botAppId required')
    this._botAppId = botAppId
    // epoch 记忆化缓存（issue #23）：message_id → 飞书原始 create_time(ms)。
    // epoch 不可变，一旦拉到即可跨 tick 复用；仅当 shortcut 出现缓存未覆盖的新 id 时才补拉，
    // 空转（窗口内 id 集不变）永不重复打 raw 调用 → listRecentMessages 从 2 次计费降到 1 次。
    this._epochCache = new Map()
    // push transport 状态（startListening 时初始化）
    this._listen = null
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

  // issue #21：`+chat-messages-list` shortcut 渲染出的 create_time 是主机本地时区墙钟串（无秒），
  // 非北京时区主机上按固定偏移解析会整体错位 → poll.js 时间游标 `createTimeMs <= lastTime`
  // 静默丢消息（丢在所有可观测分支之前，进程/认证/网络全正常，极难定位）。
  //
  // 这里走 raw OpenAPI 端点 GET /open-apis/im/v1/messages 取**未经 lark-cli 格式化**的原始
  // create_time（Unix 毫秒串，是飞书服务器盖的绝对时刻 —— 与主机时区、主机时钟、lark-cli 版本
  // 的渲染行为全部无关），建 message_id → epochMs 映射供 listRecentMessages 覆盖。
  //
  // 任何失败（端点不可用 / 解析异常 / scope 变动）静默返回空 map，调用方对 miss 的 id 回落到
  // parseCreateTimeMs 本地解析兜底 —— 最坏退化为「本地时区自洽解析」，绝不回落到坏的固定偏移。
  _fetchCreateTimeEpochs({ chatId, pageSize }) {
    const map = new Map()
    try {
      const params = JSON.stringify({
        container_id_type: 'chat',
        container_id: chatId,
        sort_type: 'ByCreateTimeDesc',
        page_size: pageSize,
      })
      const out = this._run(['api', 'GET', '/open-apis/im/v1/messages', '--as', 'bot', '--params', params])
      const json = this._parseJson(out)
      const items = (json && json.data && json.data.items) || []
      for (const it of items) {
        if (!it || !it.message_id) continue
        const ms = Number(it.create_time)
        if (Number.isFinite(ms) && ms > 0) map.set(it.message_id, ms)
      }
    } catch {
      // 静默降级：见方法头注释，调用方用 parseCreateTimeMs 兜底
    }
    return map
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
    const ids = raw.filter(m => m && m.message_id).map(m => m.message_id)
    // 权威 epoch 覆盖：shortcut 保留其全部富化（content 渲染 / mentions / 资源），
    // 仅时间戳改用 raw 端点的绝对 epoch（时区无关 + 满毫秒精度，见 _fetchCreateTimeEpochs）。
    //
    // issue #23 记忆化：raw 是第二次计费请求，空转时纯浪费（窗口内 id 每 tick 不变）。
    // 仅当 shortcut 返回缓存未覆盖的新 message_id 时才补拉 —— 新消息（含同分钟兄弟）一次 raw
    // 拉回全窗口精确 epoch，精度不降；空转命中缓存 → 省掉整个第二次调用（2→1 计费/ tick）。
    // raw 失败静默返空 → 新 id 不入缓存 → 下 tick 自动重试，其间回落 parseCreateTimeMs（同旧行为）。
    if (ids.some(id => !this._epochCache.has(id))) {
      const fresh = this._fetchCreateTimeEpochs({ chatId, pageSize })
      for (const [id, ms] of fresh) this._epochCache.set(id, ms)
      // prune 到当前窗口，界定缓存大小（epoch 不可变，丢弃出窗 id 无副作用）
      if (this._epochCache.size > ids.length) {
        const keep = new Set(ids)
        for (const id of this._epochCache.keys()) if (!keep.has(id)) this._epochCache.delete(id)
      }
    }
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
          createTimeMs: this._epochCache.get(m.message_id) || parseCreateTimeMs(m.create_time),
          mentions: normalizeMentions(m.mentions),
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

  // ---- push transport（issue #23 Phase 3）----

  // 单条消息的 mentions 只能从 raw 端点拿（event consume 已把 @ 渲染进 content 文本，不带结构化
  // mentions）。仅在 content 含 '@' 时调用，1 次计费 —— 只为 @他人过滤的精准性买单，空闲不花。
  _fetchMentions(messageId) {
    try {
      const out = this._run(['api', 'GET', `/open-apis/im/v1/messages/${messageId}`, '--as', 'bot'], { timeout: 10 * 1000 })
      const json = this._parseJson(out)
      const it = ((json && json.data && json.data.items) || [])[0]
      return normalizeMentions(it && it.mentions)
    } catch {
      return []
    }
  }

  // event consume 吐出的扁平事件 → 标准 Message（与 listRecentMessages 同契约）
  _normalizeEvent(ev) {
    if (!ev || typeof ev !== 'object') return null
    const id = ev.message_id || ev.id
    if (!id) return null
    const senderId = String(ev.sender_id || '')
    const content = sanitize(ev.content)
    return {
      id,
      senderId,
      // 事件不会推 bot 自己发的消息；其它 bot 的消息 sender 是 app id（cli_ 前缀）
      senderType: (senderId === this._botAppId || /^cli_/.test(senderId)) ? 'bot' : 'user',
      type: ev.message_type,
      content,
      createTimeMs: Number(ev.create_time) || Number(ev.timestamp) || Date.now(),
      mentions: content.includes('@') ? this._fetchMentions(id) : [],
      raw: ev,
    }
  }

  /**
   * 建立事件长连接。resolve = 已收到 ready 标记；reject = 起不来（err.fatal=true 表示环境不满足，
   * 重试无意义，调用方应回落 polling）。
   * ready 之后的断流由本 adapter 自己按退避重连；连续 RECONNECT_MAX_ATTEMPTS 次失败或遇 fatal
   * envelope → onError(err) 且 err.fatal=true，之后不再重连。
   */
  async startListening({ chatId, onMessage, onError } = {}) {
    if (!onMessage) throw new Error('startListening: onMessage required')
    if (!chatId) throw new Error('startListening: chatId required')
    if (this._listen) throw new Error('startListening: already listening')
    this._listen = { chatId, onMessage, onError, stopped: false, child: null, attempts: 0, timer: null }
    await this._spawnConsumer()
  }

  _spawnConsumer() {
    const L = this._listen
    return new Promise((resolve, reject) => {
      const env = { ...process.env, LARK_CLI_NO_PROXY: '1' }
      // 跟 _run 同款：经 bash 解析 PATH（Windows 借 Git Bash 的 sh shim）；exec 让 lark-cli 直接
      // 顶替 bash 进程，信号 / stdin EOF 不隔一层。
      const cmd = ['exec', LARK_BIN, 'event', 'consume', EVENT_KEY, '--as', 'bot'].map(quoteArg).join(' ')
      let child
      try {
        child = spawn('bash', ['-c', cmd], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      } catch (err) {
        reject(Object.assign(new Error(`spawn failed: ${err.message}`), { fatal: true }))
        return
      }
      L.child = child
      let ready = false
      let settled = false
      let stderrBuf = ''
      const settle = (fn, v) => { if (!settled) { settled = true; fn(v) } }

      const readyTimer = setTimeout(() => {
        if (ready) return
        try { child.kill('SIGTERM') } catch {}
        settle(reject, Object.assign(new Error(`event consume 未在 ${READY_TIMEOUT_MS / 1000}s 内 ready`), { fatal: false }))
      }, READY_TIMEOUT_MS)

      readline.createInterface({ input: child.stderr }).on('line', (line) => {
        stderrBuf = (stderrBuf + line + '\n').slice(-8000)
        if (!ready && READY_RE.test(line)) {
          ready = true
          clearTimeout(readyTimer)
          L.attempts = 0
          settle(resolve)
        }
      })

      // stdout 逐行 JSON → 归一 → onMessage。串行处理保序（_fetchMentions 是同步 execSync）。
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (L.stopped) return
        let ev
        try { ev = JSON.parse(line) } catch { return }
        try {
          if (ev && ev.chat_id && ev.chat_id !== L.chatId) return  // 只收配置的那个群
          const m = this._normalizeEvent(ev)
          if (m) L.onMessage(m)
        } catch (err) {
          if (L.onError) L.onError(err)
        }
      })

      child.on('error', (err) => {
        clearTimeout(readyTimer)
        settle(reject, Object.assign(new Error(`event consume spawn error: ${err.message}`), { fatal: true }))
      })

      child.on('exit', (code, signal) => {
        clearTimeout(readyTimer)
        if (L.child === child) L.child = null
        const envelope = parseErrorEnvelope(stderrBuf)
        const reason = parseExitReason(stderrBuf)
        const detail = envelope
          ? `${envelope.type}/${envelope.subtype || ''}: ${envelope.message || ''}${envelope.hint ? ' | hint: ' + envelope.hint : ''}`
          : `exit code=${code} signal=${signal || ''}${reason ? ' reason=' + reason : ''}`
        const fatal = !!(envelope && FATAL_ERROR_TYPES.has(envelope.type))
        if (!ready) {
          settle(reject, Object.assign(new Error(`event consume 启动失败: ${detail}`.slice(0, 600)), { fatal, envelope }))
          return
        }
        if (L.stopped) return
        // ready 之后掉线：fatal envelope → 交 poll.js 回落；否则退避重连
        if (fatal) {
          this._listen = null
          if (L.onError) L.onError(Object.assign(new Error(`event stream 断开且不可恢复: ${detail}`.slice(0, 600)), { fatal: true, envelope }))
          return
        }
        if (L.onError) L.onError(Object.assign(new Error(`event stream 断开，准备重连: ${detail}`.slice(0, 300)), { fatal: false, transient: true }))
        this._scheduleReconnect()
      })
    })
  }

  _scheduleReconnect() {
    const L = this._listen
    if (!L || L.stopped) return
    L.attempts += 1
    if (L.attempts > RECONNECT_MAX_ATTEMPTS) {
      this._listen = null
      if (L.onError) L.onError(Object.assign(new Error(`event stream 连续 ${RECONNECT_MAX_ATTEMPTS} 次重连失败`), { fatal: true }))
      return
    }
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, L.attempts - 1), RECONNECT_MAX_MS)
    L.timer = setTimeout(() => {
      L.timer = null
      if (L.stopped) return
      this._spawnConsumer().catch((err) => {
        if (err && err.fatal) {
          this._listen = null
          if (L.onError) L.onError(Object.assign(err, { fatal: true }))
          return
        }
        this._scheduleReconnect()
      })
    }, delay)
    if (L.timer.unref) L.timer.unref()
  }

  // 优雅停：先关 stdin（lark-cli 的无界 consume 以 EOF 为退出信号，会走 OAPI 退订不留服务端订阅），
  // 3s 没退再 SIGTERM。绝不 SIGKILL（lark-event skill 明说会漏退订）。
  async stopListening() {
    const L = this._listen
    if (!L) return
    L.stopped = true
    if (L.timer) { clearTimeout(L.timer); L.timer = null }
    this._listen = null
    const child = L.child
    if (!child) return
    await new Promise((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      child.once('exit', finish)
      try { child.stdin.end() } catch {}
      setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, STOP_GRACE_MS).unref()
      setTimeout(finish, STOP_GRACE_MS + 2000).unref()
    })
  }

  // 同步版，给 process 'exit' / 信号处理器用（那里等不了 Promise）
  stopListeningSync() {
    const L = this._listen
    if (!L) return
    L.stopped = true
    if (L.timer) { clearTimeout(L.timer); L.timer = null }
    this._listen = null
    if (L.child) {
      try { L.child.stdin.end() } catch {}
      try { L.child.kill('SIGTERM') } catch {}
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
