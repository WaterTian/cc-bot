#!/usr/bin/env node
// cc-bot Slack 包装 CLI — 跨平台 + UTF-8 安全 + token 不入命令行。
//
// 设计动机：
//   - lark-cli 是飞书生态官方 CLI，Slack 无等价物（slack-cli 是 App 开发工具不发消息）
//   - Windows Git Bash + curl 命令行中文走 GBK 编码乱（实测翻车）
//   - PowerShell Invoke-RestMethod 在 Mac/Linux 没有
//   - SKILL 教 LLM 现拼 Web API 调用心智负担高、token 反复入命令行有泄漏风险
//   ⇒ Node 包装层吃跨平台 + UTF-8 + token 自读 profile，对齐 lark-cli 风格
//
// 用法：
//   node runtime/slack-send.js send-text --project <abs> --text "<msg>"
//   node runtime/slack-send.js send-image --project <abs> --image <path>
//   node runtime/slack-send.js download --project <abs> --file-id <id> --output <path>
//   node runtime/slack-send.js auth-test --project <abs>
//   node runtime/slack-send.js user-info --project <abs> --user <U0xxx>
//
// 设计决策：所有消息一律发到 channel 主流，**不暴露 thread/reply-to 选项**。
// 理由：cc-bot 在 Slack 上的人设是"群里的开发同事"，连续主流对话比 thread 体验顺；
// 也跟飞书行为对齐（飞书 reply 是引用框、不分裂主流）。LLM 不需要思考 thread 语义。
//
// 参数语义：
//   --project <abs>     目标项目根目录（含 .cc-bot/profiles/active.json）；缺省读 CC_BOT_PROJECT 环境变量
//
// 输出：单行 JSON 到 stdout（{ok:true/false, ...}），错误写 stderr + exit code 非 0
// 失败约定：网络/SDK/参数错误 → exit 1；profile 缺失/非 slack → exit 2

const fs = require('fs')
const path = require('path')

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const next = argv[i + 1]
      // 布尔标志：下一个 argv 是 --xxx 或缺失时
      if (next === undefined || next.startsWith('--')) out[k] = true
      else { out[k] = next; i++ }
    } else out._.push(a)
  }
  return out
}

function fail(msg, code = 1) {
  process.stderr.write(`slack-send: ${msg}\n`)
  process.exit(code)
}

function loadProfile(projectRoot) {
  const p = path.join(projectRoot, '.cc-bot', 'profiles', 'active.json')
  let raw
  try { raw = fs.readFileSync(p, 'utf8') }
  catch { fail(`profile not found: ${p}`, 2) }
  try { return JSON.parse(raw) }
  catch (e) { fail(`profile JSON invalid: ${e.message}`, 2) }
}

function loadAdapter(profile) {
  if (!profile.im || profile.im.type !== 'slack') {
    fail(`im.type !== "slack" (got: ${profile.im && profile.im.type})`, 2)
  }
  const extra = profile.im.extra || {}
  if (!extra.bot_token || !extra.app_token || !profile.im.bot_user_id) {
    fail('profile missing im.extra.bot_token / im.extra.app_token / im.bot_user_id', 2)
  }
  const { SlackAdapter } = require(path.join(__dirname, '..', 'adapters', 'slack'))
  return new SlackAdapter({
    botToken: extra.bot_token,
    appToken: extra.app_token,
    botUserId: profile.im.bot_user_id,
  })
}

function jsonOut(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (!cmd) {
    fail('usage: slack-send.js <send-text|send-image|download|auth-test|user-info> [--args]')
  }
  const args = parseArgs(argv.slice(1))
  const projectRoot = path.resolve(args.project || process.env.CC_BOT_PROJECT || '.')
  const profile = loadProfile(projectRoot)
  const adapter = loadAdapter(profile)
  const chatId = profile.im.chat_id

  try {
    switch (cmd) {
      case 'send-text': {
        if (!args.text) fail('send-text: --text required')
        // 主流强制：不接受 --reply-to（即使 LLM 误传也忽略）
        const r = await adapter.sendText({ chatId, text: String(args.text) })
        jsonOut({ ok: true, ts: r.id })
        break
      }
      case 'send-image': {
        if (!args.image) fail('send-image: --image required')
        const r = await adapter.sendImage({ chatId, imagePath: String(args.image) })
        jsonOut({ ok: true, file_id: r.id })
        break
      }
      case 'download': {
        if (!args['file-id'] || !args.output) fail('download: --file-id and --output required')
        const r = await adapter.downloadResource({
          messageId: '',
          fileKey: String(args['file-id']),
          type: 'file',
          output: String(args.output),
        })
        jsonOut({ ok: true, path: r.path })
        break
      }
      case 'auth-test': {
        const r = await adapter._web.auth.test()
        jsonOut({ ok: !!r.ok, user: r.user, team: r.team, user_id: r.user_id, bot_id: r.bot_id })
        break
      }
      case 'user-info': {
        if (!args.user) fail('user-info: --user required (U0xxx)')
        const r = await adapter.getUser({ userId: String(args.user) })
        jsonOut({ ok: true, id: r.id, name: r.name })
        break
      }
      default:
        fail(`unknown command: ${cmd}`)
    }
  } catch (err) {
    jsonOut({ ok: false, error: err.message })
    process.exit(1)
  }
}

main()
