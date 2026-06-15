#!/usr/bin/env node
// cc-bot ACK 消息检测
//
// 群里短回复（"OK"/"嗯"/"继续"/"好的"）的语义识别 + 推荐回复。
// 当前 SKILL.md §ACK 消息立刻响应 用 prose 教 LLM 判断；改用代码后省 token + 快路径确定。
//
// 接口：
//   ack.detect(text)
//     → { isAck, kind: 'yes'|'continue'|'ok'|'thanks'|null, suggestedReply: string|null, confidence: 0..1 }
//
// CLI 模式：
//   node runtime/ack-detect.js detect --text "可以"
//   → {"isAck":true,"kind":"yes","suggestedReply":"好","confidence":0.95}
//
// 设计：
//   1. 长度 ≤ 12 字符（中文）/ ≤ 24 字符（含英文）才参与判定，长消息一律 false
//   2. 关键词集匹配 + 整体相似度（忽略空格 / 标点）
//   3. ACK 类别：
//      yes      —— 是/对/嗯/好/好的/OK/yes/y → 推荐回 "好"
//      continue —— 继续/下一步/接着/next     → 推荐回 "继续中"
//      ok       —— 没问题/行/可以/ok 了      → 推荐回 "好"
//      thanks   —— 谢/谢谢/thanks/感谢       → 推荐回 null（避免回复风暴）
//
// 不要把"不"/"否"/"取消"/"等等" 等否定/中止意图识别成 ACK——返 isAck=false 由 LLM 处理。

const KEYWORDS = {
  yes: ['是', '是的', '对', '对的', '嗯', '好', '好的', 'ok', 'okay', 'yes', 'yeah', 'yep', 'y', '收到', '懂了', '明白'],
  continue: ['继续', '接着', '下一步', '下一项', '继续做', 'next', 'go on', 'continue'],
  ok: ['可以', '行', '没问题', '没事', '行的', 'ok 了', '可以的'],
  thanks: ['谢', '谢谢', '多谢', '感谢', 'thanks', 'thx', 'thank you', '辛苦了', '辛苦'],
}

const STOP_WORDS = ['不', '否', '取消', '停下', '等等', '别', 'no', 'cancel', 'stop', 'wait']

const SUGGESTED_REPLY = {
  yes: '好',
  ok: '好',
  continue: '继续中',
  thanks: null,
}

function normalize(text) {
  // 去除标点、emoji、收尾空白；保留中英数字
  return String(text || '')
    .toLowerCase()
    .replace(/[\s!?,，。.!?…]+/g, '')
    .trim()
}

function lengthLimit(text) {
  // 中文 ≤ 12 字 / 含英文允许到 24 字。短消息才考虑 ACK
  if (!text) return false
  if (text.length <= 12) return true
  if (text.length <= 24 && /[a-zA-Z]/.test(text)) return true
  return false
}

function detect(text) {
  if (!text || typeof text !== 'string') {
    return { isAck: false, kind: null, suggestedReply: null, confidence: 0 }
  }
  if (!lengthLimit(text)) {
    return { isAck: false, kind: null, suggestedReply: null, confidence: 0, reason: 'too-long' }
  }
  const norm = normalize(text)

  // 含停止词直接否决
  for (const stop of STOP_WORDS) {
    if (norm.includes(normalize(stop))) {
      return { isAck: false, kind: null, suggestedReply: null, confidence: 0, reason: 'stop-word' }
    }
  }

  // 按 priority 找命中：先 yes/ok/continue，再 thanks（thanks 优先级低，避免"谢谢继续"被识别成 thanks）
  for (const kind of ['continue', 'yes', 'ok', 'thanks']) {
    for (const kw of KEYWORDS[kind]) {
      const kwNorm = normalize(kw)
      if (!kwNorm) continue
      // 完全匹配 → 高置信
      if (norm === kwNorm) {
        return {
          isAck: true, kind,
          suggestedReply: SUGGESTED_REPLY[kind] || null,
          confidence: 0.95,
        }
      }
      // 包含匹配（短消息里包含关键词）→ 中置信
      if (norm.includes(kwNorm) && kwNorm.length >= 2) {
        return {
          isAck: true, kind,
          suggestedReply: SUGGESTED_REPLY[kind] || null,
          confidence: 0.7,
        }
      }
    }
  }

  return { isAck: false, kind: null, suggestedReply: null, confidence: 0 }
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
    '  ack-detect.js detect --text "<消息>"',
    '',
    'Output:',
    '  {"isAck":true|false,"kind":"yes|continue|ok|thanks"|null,"suggestedReply":"..."|null,"confidence":0..1}',
    '',
    'isAck=true → 立刻推 state、回 suggestedReply（≤15 字）、马上接着干',
  ].join('\n')
}

function main() {
  const [, , subcmd, ...rest] = process.argv
  if (!subcmd || subcmd === '--help' || subcmd === '-h') {
    process.stdout.write(usage() + '\n')
    process.exit(0)
  }
  const args = parseArgs(rest)
  if (subcmd === 'detect') {
    if (typeof args.text !== 'string') {
      process.stderr.write('--text required\n' + usage() + '\n')
      process.exit(2)
    }
    process.stdout.write(JSON.stringify(detect(args.text)) + '\n')
  } else {
    process.stderr.write(`unknown subcommand: ${subcmd}\n${usage()}\n`)
    process.exit(2)
  }
}

if (require.main === module) main()

module.exports = { detect, KEYWORDS, STOP_WORDS, SUGGESTED_REPLY, normalize, lengthLimit }
