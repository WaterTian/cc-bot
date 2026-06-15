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
// 设计：仿 Claude-to-IM 单 markdown 元素 + element_id:'streaming_content' + 全文累积；
//      sequence 自管，Feishu 9499 / cc-bot 2026-06-15 实测踩过的 settings 嵌套坑直接绕过。

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const redact = require('./redact')

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

function buildCard({ content, streaming, summary, terminal }) {
  const text = (content && content.trim()) ? truncate(content, MAX_CONTENT_CHARS) : '🧠 思考中...'
  const config = {
    streaming_mode: !!streaming,
    summary: { content: summary || (streaming ? '思考中...' : '已完成') },
  }
  if (streaming) {
    // streaming_config 控制 typewriter 节奏；不写也能跑（用 Feishu 默认 70ms/1），
    // 显式写出来后可调速。print_strategy: 'fast' = 未打完瞬切到新内容；'delay' = 续打完旧文本再上新。
    config.streaming_config = {
      print_frequency_ms: { default: 100 },
      print_step: { default: 2 },
      print_strategy: 'fast',
    }
  }
  // Header：template 大色条 + 极简标题 + unicode 几何字符。
  //   running → blue   · "● 处理中"
  //   done    → green  · "✓ 已完成"
  //   error   → red    · "✕ 失败"
  // 不用 standard_icon（token catalog 不稳定，实测不渲染），unicode 字符保证 100% 显示。
  const template = terminal === 'error' ? 'red' : terminal === 'done' ? 'green' : 'blue'
  const titleText = terminal === 'error' ? '✕ 失败'
                  : terminal === 'done'  ? '✓ 已完成'
                  : '● 处理中'
  return {
    schema: '2.0',
    config,
    header: {
      title: { tag: 'plain_text', content: titleText },
      template,
      padding: '4px 12px 4px 12px',
    },
    body: {
      elements: [{
        tag: 'markdown',
        element_id: ELEMENT_ID,
        content: text,
      }],
    },
  }
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
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(state, null, 2))
}

// === transports ===

function isOmId(s) {
  return typeof s === 'string' && s.startsWith('om_')
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
  const enabled = im.streaming_card && im.streaming_card.enabled === true

  // 自动脱敏：worker 写的 --content / --error-msg 强制过一遍 redact，
  // 替换 slack token / 飞书 ID / 真名（profile.privacy.blocklist）/ 邮箱 / 手机号等敏感串。
  // worker 无需自己调 redact CLI——一站式入口都走这里。
  if (typeof content === 'string') content = redact.text(content, profile)
  if (typeof errorMsg === 'string') errorMsg = redact.text(errorMsg, profile)

  const file = stateFilePath(project, msgId)
  let state = readState(file)

  // ===== 路径 1：profile flag 关 → 直接走普通 reply =====
  if (!enabled && !state) {
    sendPlainText({ replyTo: msgId, chatId, content })
    writeState(file, { mode: 'reply', terminal: 'done', createdAt: Date.now() })
    return ok({ mode: 'reply', reason: 'flag-off' })
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
      const card = buildCard({ content: initState.content, streaming: true, summary: summaryFor(initState) })
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

    // 首次调用就带 --final → 卡刚建立立刻 finalize
    if (isFinal || status === 'error') {
      return doFinalize({ state, file, content: initialContent, status, errorMsg })
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

  // 中途 update
  state.sequence += 1
  try {
    updateCardContent({ cardId: state.cardId, content: state.content || '🧠 思考中...', sequence: state.sequence })
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
  const finalCard = buildCard({
    content: state.content,
    streaming: false,
    summary: summaryFor(state),
    terminal: state.terminal,
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
  buildCard, summaryFor, truncate,
  readProfile, stateFilePath, readState, writeState,
  cmdReport,
  ELEMENT_ID, MAX_CONTENT_CHARS,
}
