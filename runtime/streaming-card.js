#!/usr/bin/env node
// cc-bot 流式卡片 CLI（lark only）
//
// 一个命令包打：worker subagent 全程只调 `streaming-card.js report ...`，CLI 内部按 profile
// + state 自动决定：起卡 / 中途 update / 收尾 finalize / 失败降级到普通 +messages-reply。
// worker.md 不再有 "if 流式卡片 then 三步骤 else +messages-reply" 的分支负担。
//
// 流程（全部在 CLI 里）：
//   1. 读 profile.im.streaming_card.enabled
//      - 关 → 直接 lark-cli im +messages-reply，无视后续 --final
//      - 开 → 走卡片流
//   2. 卡片流首次调用 → cardkit POST /cards 建实体 + im +messages-send 发消息
//      建卡失败 → 静默降级到 +messages-reply，state 记 mode=fallback，后续调用一直走 reply
//   3. 卡片流后续调用：
//      无 --final → PUT /cards/{id}/elements/streaming_content/content（typewriter 累加）
//      有 --final → 整卡 PUT /cards/{id} 替换（翻 header 蓝→绿/红 + 关 streaming_mode + 上最终内容）
//
// 设计：单 markdown 元素 + element_id:'streaming_content' + 全文累积；
//      sequence 自管，Feishu 9499 / cc-bot 2026-06-15 实测踩过的 settings 嵌套坑直接绕过。

const { execSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const redact = require('./redact')
const { canUseStreamingCard } = require('./streaming-card-policy')
const { atomicWriteSync } = require('./atomic-write')

const LARK_BIN = 'lark-cli'
const DEFAULT_TIMEOUT_MS = 15 * 1000
const ELEMENT_ID = 'streaming_content'
const MAX_CONTENT_CHARS = 8000  // Feishu 元素 ~30KB 上限；保守用 8000 字符上限，超过截首尾保留

// === lark-cli wrapper ===

function quoteArg(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function execLark(args, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const env = { ...process.env, LARK_CLI_NO_PROXY: '1' }
  const cmd = [LARK_BIN, ...args.map(quoteArg)].join(' ')
  let out
  try {
    out = execSync(cmd, {
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
  const i = out.indexOf('{')
  const body = i >= 0 ? out.slice(i) : out
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`lark-cli output not JSON: ${out.slice(0, 200)}`)
  }
}

// === card schema ===

function buildCard({ content, streaming, summary, terminal, elapsedMs }) {
  const text = (content && content.trim()) ? truncate(content, MAX_CONTENT_CHARS) : '🧠 思考中...'
  const config = {
    streaming_mode: !!streaming,
    summary: { content: summary || (streaming ? '思考中...' : '已完成') },
    wide_screen_mode: true,
  }
  if (streaming) {
    // streaming_config 控制 typewriter 节奏。print_strategy: 'fast' = 未打完瞬切到新内容；'delay' = 续打完旧文本再上新。
    config.streaming_config = {
      print_frequency_ms: { default: 60 },
      print_step: { default: 4 },
      print_strategy: 'fast',
    }
  }
  // Header：template 色条 + 极简标题 + unicode 几何字符。
  //   running → blue   · "● 处理中"
  //   done    → green  · "✓ 已完成"
  //   error   → red    · "✕ 失败"
  const template = terminal === 'error' ? 'red' : terminal === 'done' ? 'green' : 'blue'
  const titleText = terminal === 'error' ? '✕ 失败'
                  : terminal === 'done'  ? '✓ 已完成'
                  : '● 处理中'

  // Body 设计：主元素 (typewriter) + hr 分隔 + 右对齐小灰字 footer meta。
  // 流式更新只触发 element_id='streaming_content'，hr/footer 静态不抖动。
  // finalize 时整卡 PUT 替换，footer 显示耗时（"3s" / "1m 20s" 等）。
  let footerText
  if (terminal === 'done') {
    footerText = elapsedMs ? `已完成 · ${formatElapsed(elapsedMs)}` : '已完成'
  } else if (terminal === 'error') {
    footerText = elapsedMs ? `已终止 · ${formatElapsed(elapsedMs)}` : '已终止'
  } else {
    footerText = '正在输出'
  }

  return {
    schema: '2.0',
    config,
    header: {
      title: { tag: 'plain_text', content: titleText },
      template,
      padding: '6px 16px 6px 16px',
    },
    body: {
      elements: [
        { tag: 'markdown', element_id: ELEMENT_ID, content: text, text_align: 'left' },
        { tag: 'hr', margin: '8px 0 8px 0' },
        { tag: 'markdown', content: footerText, text_size: 'notation', text_color: 'grey', text_align: 'right' },
      ],
    },
  }
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}h ${rm}m` : `${h}h`
}

// v0.1.30 noop：Feishu CardKit 的 markdown 元素原生支持完整 markdown 语法
// （`-`/`*` 无序列表 / `1.` 有序 / `**bold**` / `` `code` `` / `### heading` / `> quote` /
//  ` ``` fenced ``` ` 等）。早期 A2 设计把 `- ` 替换为 `▸ ` 反而 downgrade 了原生列表样式，已撤回。
// 函数保留作为后续扩展点（比如统一英文标点 / 自动 inline code 等），目前 passthrough。
function prettifyContent(s) {
  return s
}

function truncate(s, max) {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.7)
  const tail = max - head - 64
  return s.slice(0, head) + `\n\n_… (truncated ${s.length - head - tail} chars) …_\n\n` + s.slice(-tail)
}

function summaryFor(state) {
  if (state.terminal === 'done') return '已完成'
  if (state.terminal === 'error') return '失败'
  if (state.content && state.content.trim()) return '处理中'
  return '思考中'
}

// === profile + state ===

function readProfile(projectRoot) {
  const file = path.join(projectRoot, '.cc-bot', 'profiles', 'active.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`profile read failed (${file}): ${e.message}`)
  }
}

function stateFilePath(projectRoot, msgId) {
  return path.join(projectRoot, '.cc-bot', 'runtime', `stream-${msgId}.json`)
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeState(file, state) {
  atomicWriteSync(file, JSON.stringify(state, null, 2))
}

// v0.1.36+ content hash dedup — todo-bridge.js 主会话 TodoWrite 高频触发同 diff，
// 重复 patch 同内容到 CardKit 浪费 quota + 客户端闪烁。state.lastContentHash 缓存
// 上次实际发往 CardKit 的内容 sha1；report 入口 hash 等于上次直接 skip。
function contentHash(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex')
}

// === transports ===

// 飞书 open_message_id 严格格式：`om_` 前缀 + ≥20 alphanumeric 字符（实测 om_x100b6dc37c2d88b8b30ece54f94cae8 这种 36 字符）。
// 旧版只检前缀导致 fake id（如 om_e2e_test）被认作真 om_，触发 reply 路径报"must start with om_"——表面 prefix 对但 id 不存在。
// 收紧后 fake id 走 chat-id 直发分支，测试场景顺畅。
const OM_ID_PATTERN = /^om_[a-z0-9]{20,}$/i

function isOmId(s) {
  return typeof s === 'string' && OM_ID_PATTERN.test(s)
}

function sendPlainText({ replyTo, chatId, content }) {
  // 真 om_ msg id → reply 模式；fake/测试 id → chat 直发。
  // worker 实际场景 msg_id 永远是 om_，走 reply；smoke test 用 fake id 走直发。
  const text = (typeof content === 'string' && content) ? content : '(无内容)'
  const useReply = isOmId(replyTo)
  const args = useReply
    ? ['im', '+messages-reply', '--as', 'bot', '--message-id', replyTo, '--msg-type', 'text', '--content', JSON.stringify({ text })]
    : ['im', '+messages-send',  '--as', 'bot', '--chat-id', chatId,    '--msg-type', 'text', '--content', JSON.stringify({ text })]
  if (!useReply && !chatId) throw new Error('sendPlainText: no replyTo (om_xxx) and no chatId')
  const out = execLark(args)
  return { messageId: out && out.data && out.data.message_id }
}

function createCardEntity(card) {
  const res = execLark([
    'api', 'POST', '/open-apis/cardkit/v1/cards',
    '--as', 'bot',
    '--data', JSON.stringify({ type: 'card_json', data: JSON.stringify(card) }),
  ])
  const cardId = res && res.data && res.data.card_id
  if (!cardId) throw new Error('cardkit create returned no card_id: ' + JSON.stringify(res).slice(0, 300))
  return cardId
}

function sendCardMessage({ cardId, replyTo, chatId }) {
  // 同 sendPlainText：om_ → reply；否则 chat 直发。
  const contentJson = JSON.stringify({ type: 'card', data: { card_id: cardId } })
  const useReply = isOmId(replyTo)
  const args = useReply
    ? ['im', '+messages-reply', '--as', 'bot', '--message-id', replyTo, '--msg-type', 'interactive', '--content', contentJson]
    : ['im', '+messages-send',  '--as', 'bot', '--chat-id', chatId,    '--msg-type', 'interactive', '--content', contentJson]
  if (!useReply && !chatId) throw new Error('sendCardMessage: no replyTo (om_xxx) and no chatId')
  const out = execLark(args)
  return (out && out.data && out.data.message_id) || ''
}

function updateCardContent({ cardId, content, sequence }) {
  execLark([
    'api', 'PUT',
    `/open-apis/cardkit/v1/cards/${cardId}/elements/${ELEMENT_ID}/content`,
    '--as', 'bot',
    '--data', JSON.stringify({ content, sequence }),
  ])
}

function replaceCard({ cardId, card, sequence }) {
  // 整卡 PUT 替换：一次性翻 header 颜色 + 关 streaming_mode + 上最终内容。
  execLark([
    'api', 'PUT',
    `/open-apis/cardkit/v1/cards/${cardId}`,
    '--as', 'bot',
    '--data', JSON.stringify({
      card: { type: 'card_json', data: JSON.stringify(card) },
      sequence,
    }),
  ])
}

// === report 主逻辑 ===

function cmdReport({ project, msgId, content, append, isFinal, status, errorMsg }) {
  if (!project) throw new Error('--project required')
  if (!msgId) throw new Error('--msg-id required')

  const profile = readProfile(project)
  const im = (profile && profile.im) || {}
  if (im.type !== 'lark') {
    throw new Error(`streaming-card.js: only lark supported (im.type=${im.type || 'unset'})`)
  }
  const chatId = im.chat_id
  // 顶层策略由 streaming-card-policy.canUseStreamingCard 统一判（im.type=lark 在上面已门槛，
  // 这里只取 .enabled 维度，因此 ok 等价于 streaming_card.enabled）。
  const enabled = canUseStreamingCard(profile).ok
  // v0.1.30+：判据从字符数阈值改为是否含换行。
  // worker 写多行（含 `\n`）= 想排版展示 → 卡片；单行 = 一句话答 → 文本。
  // 比 magic number 阈值更自解释；意图驱动而非长度驱动。

  // 自动脱敏：worker 写的 --content / --error-msg 强制过一遍 redact，
  // 替换 slack token / 飞书 ID / 真名（profile.privacy.blocklist）/ 邮箱 / 手机号等敏感串。
  // worker 无需自己调 redact CLI——一站式入口都走这里。
  if (typeof content === 'string') content = redact.text(content, profile)
  if (typeof errorMsg === 'string') errorMsg = redact.text(errorMsg, profile)

  // v0.1.34+ 兜底：worker 用 bash 单引号写 `\n` 字面（不解为换行）→ markdown 渲染器把字面 `\n` 当文本显示，群里翻车。
  // 判据：content 全无真换行 + 含字面 `\n` → 视作 markdown 换行约定，统一转真换行。
  // 已含真换行不动（保护 fenced code block 里的 `\n` 字面，如 `echo -e "a\nb"`）。
  if (typeof content === 'string' && !content.includes('\n') && content.includes('\\n')) {
    content = content.replace(/\\n/g, '\n')
  }

  const file = stateFilePath(project, msgId)
  let state = readState(file)

  // ===== 路径 1：profile flag 关 → 直接走普通 reply =====
  if (!enabled && !state) {
    sendPlainText({ replyTo: msgId, chatId, content })
    writeState(file, { mode: 'reply', terminal: 'done', createdAt: Date.now() })
    return ok({ mode: 'reply', reason: 'flag-off' })
  }

  // ===== 路径 1.5（v0.1.30+）：单行内容 + --final → 不建卡，直接文本 reply =====
  // 适用："好"/"Node v22.22.2"/"修改 3 个文件，测试通过 (8/8)" 等一句话短结论。
  // 含换行（worker 写了排版）→ 卡片走流式；意图驱动而非长度驱动。
  if (!state && enabled && isFinal && typeof content === 'string'
      && content.trim() && !content.includes('\n') && status !== 'error') {
    sendPlainText({ replyTo: msgId, chatId, content })
    writeState(file, {
      mode: 'reply', terminal: 'done', createdAt: Date.now(),
      reason: 'single-line',
    })
    return ok({ mode: 'reply', reason: 'single-line' })
  }

  // ===== 路径 2：首次调用 + flag 开 → 尝试建卡 =====
  if (!state) {
    if (!chatId) throw new Error('profile.im.chat_id missing')
    const initialContent = (typeof content === 'string') ? content : ''
    const initState = {
      mode: 'card',
      cardId: '', messageId: '', chatId,
      sequence: 0,
      content: initialContent,
      terminal: 'running',
      createdAt: Date.now(),
    }
    let cardId, messageId
    try {
      const card = buildCard({ content: prettifyContent(initState.content), streaming: true, summary: summaryFor(initState) })
      cardId = createCardEntity(card)
      messageId = sendCardMessage({ cardId, replyTo: msgId, chatId })
    } catch (e) {
      // 建卡或发卡失败 → 静默降级 +messages-reply
      try { sendPlainText({ replyTo: msgId, chatId, content: initialContent || '(任务进行中)' }) } catch (_) {}
      writeState(file, {
        mode: 'fallback', terminal: 'done', createdAt: Date.now(),
        fallbackReason: String(e.message || e).slice(0, 200),
      })
      return ok({ mode: 'fallback', reason: 'card-create-failed' })
    }
    state = { ...initState, cardId, messageId }
    state.lastContentHash = contentHash(prettifyContent(state.content))

    // 首次调用就带 --final → 卡刚建立立刻 finalize。
    // state.content 已经是 initialContent（initState），不再传 content 防重复 append。
    if (isFinal || status === 'error') {
      return doFinalize({ state, file, content: undefined, status, errorMsg })
    }
    writeState(file, state)
    return ok({ mode: 'card', sequence: state.sequence, action: 'created' })
  }

  // ===== 路径 3：state 已存在 =====

  // 3a. fallback 模式 / reply 模式 → 继续走普通 reply
  if (state.mode === 'fallback' || state.mode === 'reply') {
    sendPlainText({ replyTo: msgId, chatId, content })
    return ok({ mode: state.mode, action: 'extra-reply' })
  }

  // 3b. card 已 finalize → 幂等
  if (state.terminal !== 'running') {
    return ok({ mode: 'card', alreadyFinalized: true, terminal: state.terminal })
  }

  // 3c. card mid-stream：累加正文
  if (typeof content === 'string') {
    state.content = append === false ? content : (state.content + content)
  }

  if (isFinal || status === 'error') {
    return doFinalize({ state, file, content: undefined, status, errorMsg })
  }

  // 中途 update — 先 hash dedup（同 content 重复 patch 浪费 CardKit quota + 客户端闪烁）
  const rendered = prettifyContent(state.content) || '🧠 思考中...'
  const h = contentHash(rendered)
  if (state.lastContentHash === h) {
    // 不写 state（state.content 可能因 append 变了但 rendered 同；下次差异化再写）
    return ok({ mode: 'card', sequence: state.sequence, action: 'skipped-dedup' })
  }

  state.sequence += 1
  try {
    updateCardContent({ cardId: state.cardId, content: rendered, sequence: state.sequence })
    state.lastContentHash = h
    writeState(file, state)
    return ok({ mode: 'card', sequence: state.sequence, action: 'updated' })
  } catch (e) {
    // mid-stream PUT 失败：不降级（卡片还在群里，下次重试），只 stderr 警告
    state.sequence -= 1  // 回滚 sequence，下次重用
    writeState(file, state)
    process.stderr.write(`WARN: card update failed seq=${state.sequence + 1}: ${e.message}\n`)
    return ok({ mode: 'card', sequence: state.sequence, action: 'update-skipped', warn: 'put-failed' })
  }
}

function doFinalize({ state, file, content, status, errorMsg }) {
  if (typeof content === 'string') state.content = state.content + content
  state.terminal = (status === 'error') ? 'error' : 'done'
  if (errorMsg) state.errorMsg = errorMsg

  state.sequence += 1
  const elapsedMs = state.createdAt ? Date.now() - state.createdAt : 0
  const finalCard = buildCard({
    content: prettifyContent(state.content),
    streaming: false,
    summary: summaryFor(state),
    terminal: state.terminal,
    elapsedMs,
  })
  try {
    replaceCard({ cardId: state.cardId, card: finalCard, sequence: state.sequence })
    writeState(file, state)
    return ok({ mode: 'card', sequence: state.sequence, terminal: state.terminal })
  } catch (e) {
    // finalize 失败 → 发普通 reply 兜底，state 标 finalize-fallback
    try { sendPlainText({ replyTo: state.messageId || '', chatId: state.chatId, content: state.content || '(任务结束)' }) } catch (_) {}
    state.mode = 'finalize-fallback'
    state.fallbackReason = String(e.message || e).slice(0, 200)
    writeState(file, state)
    return ok({ mode: 'finalize-fallback', reason: 'final-replace-failed' })
  }
}

// === CLI ===

function ok(o) {
  process.stdout.write(JSON.stringify({ ok: true, ...o }) + '\n')
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
    '  streaming-card.js report --project <root> --msg-id <om_xxx> [--content <md>] [--final] [--status error] [--error-msg <s>] [--replace]',
    '',
    'Behavior（CLI 内部自动决策，worker 无需 if-else）：',
    '  · profile.im.streaming_card.enabled === false → 直接走 lark-cli +messages-reply',
    '  · enabled === true 首次调用 → cardkit 建卡 + 发卡（失败静默降级 reply）',
    '  · enabled === true 后续调用 → PUT element/content（typewriter 累加）',
    '  · 任意调用带 --final → 整卡替换 PUT，header 翻绿/红 + 关 streaming_mode',
    '',
    'Flags:',
    '  --content <md>   本次要追加（默认 append）或替换（带 --replace）的正文',
    '  --replace        覆盖现有正文而非追加',
    '  --final          收尾，status=done 默认',
    '  --status error   收尾且状态 error（配合 --final 或单独）',
    '  --error-msg <s>  错误简述（用于诊断，state 文件记录）',
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
    if (subcmd === 'report') {
      cmdReport({
        project: args.project,
        msgId: args['msg-id'],
        content: typeof args['content'] === 'string' ? args['content'] : undefined,
        append: args['replace'] ? false : true,
        isFinal: !!args['final'],
        status: args['status'],
        errorMsg: args['error-msg'],
      })
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
  buildCard, summaryFor, truncate, formatElapsed, prettifyContent,
  readProfile, stateFilePath, readState, writeState,
  cmdReport,
  canUseStreamingCard,
  ELEMENT_ID, MAX_CONTENT_CHARS,
}
