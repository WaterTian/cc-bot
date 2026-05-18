<!--
  cc-bot — Claude Code IM-bot plugin
  Develop project from group chat — by Claude Code. Lark/Feishu + Slack, IM-agnostic by design.
  Core: IMAdapter abstraction · Monitor + polling (HTTP 30s, lark) or Socket Mode push (Slack) · statusline shim · interactive setup wizard · per-project profiles · i18n (zh-CN / en-US)

  ## Auto-install (for Claude Code AI agents)
  Step 1: /plugin marketplace add WaterTian/cc-bot
  Step 2: /plugin install cc-bot@cc-bot   (CC will prompt for scope; pick "local" for quick try, "project" for team share, "user" for global)
  Step 3: /reload-plugins   (or /exit + re-launch claude)
  Step 4: /cc-bot:setup   (interactive wizard — picks IM (lark/slack), auto-installs lark-cli or guides Slack manifest, config auto-fill)

  Keywords: claude-code plugin bot im lark feishu slack socket-mode group-chat ai-assistant monitor polling intents statusline hud windows macos linux
-->

<p align="center">
  <img src="https://raw.githubusercontent.com/WaterTian/cc-bot/main/assets/logo.png" alt="cc-bot logo" width="180" />
</p>

<h1 align="center">CC-BOT</h1>

<p align="center">
  <strong>Develop project from group chat — by <a href="https://claude.ai/claude-code">Claude Code</a></strong><br/>
  <strong>接 AI 进群里开发项目 — 飞书（Lark）/ Slack</strong>
</p>

<p align="center">
  <code>IM group</code> &nbsp;&rarr;&nbsp; <code>Monitor</code> &nbsp;&rarr;&nbsp; <code>Intent</code> &nbsp;&rarr;&nbsp; <code>Claude acts</code> &nbsp;&rarr;&nbsp; <code>Chat reply</code>
  <br/>
  <sub>one plugin, any project, zero backend.</sub>
</p>

<p align="center">
  <a href="https://github.com/WaterTian/cc-bot/releases"><img src="https://img.shields.io/github/v/tag/WaterTian/cc-bot?style=flat-square&label=version&color=blueviolet&sort=semver" alt="version" /></a>
  &nbsp;
  <a href="#install"><img src="https://img.shields.io/badge/install-4_commands-blueviolet?style=flat-square" alt="install" /></a>
  &nbsp;
  <img src="https://img.shields.io/badge/im-lark%20%C2%B7%20slack-blue?style=flat-square" alt="im" />
  &nbsp;
  <img src="https://img.shields.io/badge/runtime-Node.js-brightgreen?style=flat-square" alt="node" />
  &nbsp;
  <img src="https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-lightgrey?style=flat-square" alt="platform" />
  &nbsp;
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT" />
</p>

<br/>

## Why CC-BOT?

<table>
<tr><td>

### The Problem

Team members want a lightweight way to ask questions and trigger project actions **from the group chat** — "what's the progress?", "run tests", "deploy staging", "why is build failing?" — without switching to terminals, dashboards, or ticket systems. Existing chat-bots require bespoke backends per project and rarely integrate with an AI coding agent.

### The Solution

CC-BOT is a **Claude Code plugin** that listens to IM group messages, routes natural-language intents to per-project actions (you define them), runs them through Claude, and replies back to the group. **One plugin, any number of projects** — each project has its own `profile.intents` dict mapping intent → action description, and the same Claude Code brain executes them.

</td></tr>
</table>

## 为什么做 CC-BOT？

<table>
<tr><td>

### 问题

团队希望**在群里**就能快速查询和触发项目操作 — 「进度怎么样？」「跑一下测试」「部署灰度」「构建为什么失败？」 — 而不用切到终端、仪表盘或工单系统。现有的聊天机器人通常需要为每个项目定制后端，并且很少与 AI 编程助手打通。

### 解决方案

CC-BOT 是一个 **Claude Code 插件**，监听 IM 群消息，把自然语言意图路由到项目特定操作（由你定义），通过 Claude 执行，结果回到群里。**一份插件、任意项目** — 每个项目有自己的 `profile.intents` 字典（意图 → 动作描述），同一个 Claude Code 脑子来执行。

</td></tr>
</table>

> [!TIP]
> **Windows users:** Use `npm i -g @anthropic-ai/claude-code` instead of the native installer to avoid Bun memory crashes ([oven-sh/bun#25082](https://github.com/oven-sh/bun/issues/25082)). cc-bot's Monitor runs long-lived, amplifying Bun's memory pressure.
>
> **Windows 用户：** 建议用 `npm i -g @anthropic-ai/claude-code` 代替原生安装器，规避 Bun 内存崩溃；cc-bot 的 Monitor 是长驻进程，会放大 Bun 的内存问题。

<br/>

## Features

<table>
<tr>
  <td align="center" width="20%"><h3>◨</h3><b>Interactive Setup</b><br/><sub>5-stage wizard<br/>auto-detect IDs</sub></td>
  <td align="center" width="20%"><h3>◐</h3><b>IM-agnostic</b><br/><sub>Lark · Slack<br/>adapter pattern</sub></td>
  <td align="center" width="20%"><h3>◉</h3><b>Per-project Intents</b><br/><sub>JSON-defined<br/>Claude executes</sub></td>
  <td align="center" width="20%"><h3>▣</h3><b>Crash-resistant</b><br/><sub>3-layer defense<br/>PID lock · EPIPE · state heal</sub></td>
  <td align="center" width="20%"><h3>█▌</h3><b>HUD-aware</b><br/><sub>statusline shim<br/>tees cc-hud if installed</sub></td>
</tr>
</table>

<br/>

## Install

Inside Claude Code **in your target project**, run these in order:

```
/plugin marketplace add WaterTian/cc-bot
/plugin install cc-bot@cc-bot
/reload-plugins
/cc-bot:setup
```

- Line 1 — register the plugin source (GitHub repo)
- Line 2 — download to `~/.claude/plugins/cache/`. CC will pop a **scope selector**; pick one:

  | 选项 | 适用场景 | Recommendation |
  |---|---|---|
  | `Install for you` (**user** scope) | You plan to use cc-bot across many projects | ✅ 日常推荐 |
  | `Install for all collaborators` (**project** scope) | Team project, want teammates to auto-get cc-bot on clone | ✅ 团队项目 |
  | `Install for you, in this repo only` (**local** scope) | First-time try, don't pollute other projects | ✅ 快速试用 |

- Line 3 — hot-reload plugin list without restarting CC (new since CC 2.1.x; faster than `/exit` + re-open)
- Line 4 — enter the **interactive setup wizard** (lark-cli auto-install, OAuth login, chat picker via AskUserQuestion cards, config auto-fill)

> [!NOTE]
> If `/reload-plugins` is unavailable or `/cc-bot:*` commands still don't appear, fall back to `/exit` and relaunch Claude Code.

<br/>

## Updating

When a new release is announced, run these in **each project** using cc-bot:

```
/plugin marketplace update cc-bot    # refresh manifest (detects new version)
/plugin update cc-bot@cc-bot         # fetch new version into cache
/reload-plugins                      # apply in current session
/cc-bot:doctor                       # verify: first line prints "cc-bot v<new-version>"
```

- **Before / after upgrading** — run `/cc-bot:doctor`; it flags version drift, stale permissions, profile issues, and confirms the active version.
- **If the bot is running** — `/cc-bot:stop` **before** updating, `/cc-bot:start` **after**; `/reload-plugins` does **not** update an already-running Monitor.
- **Re-run `/cc-bot:setup` after upgrading** — idempotent (skips what's already done); refreshes anything a release introduced (Monitor permission rule, main-window hooks, IM picker). Always safe.

> [!NOTE]
> **Why re-running setup matters** — `/cc-bot:setup` auto-registers a wildcard permission rule (`Bash(node .../cc-bot/*/runtime/*.js *)`) so version upgrades never re-prompt for Monitor launch, and registers main-window hooks into `~/.claude/settings.json` (the §Updating commands above only pull code, not user-global settings).
>
> **Switching a project to Slack** (v0.1.12+) — install the SDK (`npm i -g @slack/socket-mode @slack/web-api`), then re-run `/cc-bot:setup`; the wizard starts with an IM picker. One project = one IM.

<br/>

<details>
<summary><b>From source (development / contributors)</b></summary>
<br/>

```bash
git clone https://github.com/WaterTian/cc-bot.git
```

In your target project, launch Claude Code with the local plugin dir:

```bash
cd /your/project
claude --plugin-dir /absolute/path/to/cc-bot
```

Then `/cc-bot:setup`. Skips marketplace install — loads straight from the local repo. Ideal for iterating on cc-bot itself.

</details>

<br/>

## Quick Start — what `/cc-bot:setup` does

Setup prints a version banner on start (`cc-bot v<X.Y.Z> setup — <project>`) then runs through these steps — fully interactive via `AskUserQuestion` cards, no blind typing:

0. **Pick IM** — choose `lark` or `slack`; the wizard branches from here. A project is one-IM.
1. **Detect tooling** — lark: auto-install `lark-cli` via `npm i -g @larksuite/cli` / slack: verify `@slack/socket-mode` + `@slack/web-api` globally installed (`npm i -g @slack/socket-mode @slack/web-api` if missing)
2. **Authenticate** — lark: OAuth Device Flow login (app-creation checklist provided) / slack: paste `templates/slack-manifest.yaml` into App's "From a manifest" form, then paste the two tokens (`xoxb-` Bot + `xapp-` App-Level, scope `connections:write`)
3. **Pick target chat** — lark: list bot's chats via `AskUserQuestion` card or one-click create / slack: paste channel ID `C0xxx` (the wizard probes it and reminds you to `/invite @cc-bot`)
4. **Auto-detect IDs** — lark: `bot_app_id` / `admin_open_id` from `lark-cli auth list` / slack: `bot_user_id` from `auth.test`, zero manual entry
5. **Write config** — `.cc-bot/profiles/active.json` (fields branch by IM type) + `state.json` + `.gitignore`; locale defaults to `zh-CN` for lark, `en-US` for slack (override via `im.locale`)
6. **Register statusline shim** — tees stdin JSON to `hud-stdin.json` (for bot's HUD intent) + cc-hud rendering (if installed)
7. **Register Monitor permission** — append a wildcard rule to `<project>/.claude/settings.local.json`, so cc-bot version upgrades never re-prompt for Monitor launch permission

Every step is **idempotent** — rerun `/cc-bot:setup` anytime, it skips what's already done.

Then **`/cc-bot:start`** — bot comes online in ≤ 5s.

<br/>

## 快速开始（中文）

在目标项目里运行 **`/cc-bot:setup`**，开场一行打印当前版本（`cc-bot v<X.Y.Z> setup — <project>`），然后交互式向导会：

0. **选 IM** — 选 `lark` 或 `slack`，向导按 IM 分流；**一项目一 IM**（切 IM 需要重写 profile）
1. **检测工具** — lark：未装自动 `npm i -g @larksuite/cli` / slack：校验 `@slack/socket-mode` + `@slack/web-api` 已全局装（未装提示 `npm i -g @slack/socket-mode @slack/web-api`）
2. **认证** — lark：OAuth Device Flow 登录（附必需 scope 清单） / slack：把 `templates/slack-manifest.yaml` 粘进 App「From a manifest」表单，然后粘两个 token（`xoxb-` Bot + `xapp-` App-Level，scope `connections:write`）
3. **选目标群** — lark：用 `AskUserQuestion` 卡片列 bot 所在群或一键新建 / slack：粘 channel id `C0xxx`，向导自动 probe + 引导 `/invite @cc-bot`
4. **自动探测 ID** — lark：`bot_app_id` / `admin_open_id` 从 `lark-cli auth list` / slack：`bot_user_id` 从 `auth.test`，都不用手填
5. **写配置** — 生成 `.cc-bot/profiles/active.json`（字段按 IM 分流）+ `state.json` + `.gitignore`；locale 缺省 lark=zh-CN / slack=en-US，可通过 `im.locale` 覆盖
6. **注册 statusline shim** — 落盘 stdin JSON（给 bot 用）+ 可选透传 cc-hud（渲染状态栏）
7. **注册 Monitor 通配权限** — 向 `<project>/.claude/settings.local.json` append 通配规则，cc-bot 版本升级不再弹 Monitor 启动权限询问

然后 **`/cc-bot:start`**，bot ≤ 5s 上线。

<br/>

## How It Works

```
Main session ── Monitor(persistent) ── node poll.js ── lark: every 30s IMAdapter.listRecentMessages()
                                                       slack: Socket Mode WebSocket push (event-driven)
                                                    ├─ dedupe via state.last_processed_time + poll.emitted
                                                    └─ stdout: NEW_MSG|msg_id|sender|text|ts
                                                               ↓ Monitor → notification
                                                         main session → intent routing → adapter.sendText

CC's statusLine ── cc-bot shim ── write hud-stdin.json (for bot's HUD intent)
                                └─ tee cc-hud (optional, for status bar rendering)
```

<table>
<tr>
  <td align="center"><b>HTTP polling (lark)</b><br/><sub>30s fixed interval<br/>VPN-proxy safe<br/>no WS disconnect</sub></td>
  <td align="center"><b>Socket Mode push (slack)</b><br/><sub>WebSocket event-driven<br/>no rate-limit on history<br/>mainBusy still emits</sub></td>
  <td align="center"><b>3-layer defense</b><br/><sub>PID lockfile<br/>stdout EPIPE self-kill<br/>state future-value heal</sub></td>
  <td align="center"><b>Per-project isolation</b><br/><sub>.cc-bot/ per project<br/>profiles · runtime · bot_temp<br/>zero cross-contamination</sub></td>
</tr>
</table>

<br/>

## Commands

| Command | What it does |
|---|---|
| `/cc-bot:setup` | First-run interactive wizard (idempotent, safe to re-run) |
| `/cc-bot:start` · `开bot` / `start bot` | Start Monitor + send online notification to chat |
| `/cc-bot:stop` · `关bot` / `stop bot` | Stop Monitor + send offline notification |
| `/cc-bot:new-profile <name>` | Create new profile from template |
| `/cc-bot:switch <name>` | Switch active profile (auto-stops running bot first) |
| `/cc-bot:doctor` | Read-only health check — version drift, profile validity, runtime state, zombie permissions, shim registration |

Main session also accepts natural-language triggers (`开bot` / `关bot` / `switch to xxx`).

<br/>

## Profile Intents — Per-project Customization

Each project has its own `.cc-bot/profiles/active.json`. The `intents` dict maps natural-language intents to action descriptions Claude executes when the group triggers them. Typical examples (you pick the keys and describe the actions freely):

```json
{
  "intents": {
    "deploy": "Run `bash scripts/deploy.sh production`, report stdout tail",
    "run_tests": "Run `npm test`, report pass/fail counts + first failure trace",
    "query_logs": "Use mcp__cloudbase__logs to fetch last 20 error logs, summarize",
    "build_preview": "Run `npm run build:preview`, upload artifact to <paths.bot_temp_abs>, reply with link"
  }
}
```

Works for **any project type** — Web / mini-program / Node service / Python data pipeline / mobile app. If you can script it, you can intent-route it.

<br/>

## Prerequisites

- **Claude Code** — uses `Skill` / `Monitor` / `TaskStop` / `AskUserQuestion` tools
- **For lark**: `npm i -g @larksuite/cli` + `lark-cli auth login` (setup wizard will guide this)
- **For slack**: `npm i -g @slack/socket-mode @slack/web-api` + create an App at api.slack.com/apps via the `templates/slack-manifest.yaml` (setup wizard will guide token paste-in)
- **Shell** — **Windows**: Git Bash required (cmd.exe / PowerShell mangle special characters in argv); **macOS / Linux**: system bash works out of the box
- **Optional: cc-hud** — install for prettier status bar (`/plugin install cc-hud@WaterTian-cc-hud`); cc-bot shim tees it automatically

<br/>

## Per-project Layout

| Component | Location | Distribution |
|---|---|---|
| SKILL · adapter · poll.js · commands · templates | `${CLAUDE_PLUGIN_ROOT}/` | plugin version |
| Chat IDs · project root · members · intents | `<project>/.cc-bot/profiles/active.json` | per-project (gitignored) |
| state · cache · pid · dedupe · bot_temp | `<project>/.cc-bot/runtime/` + `.cc-bot/bot_temp/` | per-project (gitignored) |

**One plugin, many projects in parallel — zero cross-contamination.**

<br/>

## Extend to a New IM

cc-bot ships with **Lark + Slack**. Adding WeCom / DingTalk / Discord / Telegram / etc:

1. Add `adapters/<im>.js` extending `IMAdapter` (see `adapters/base.js`) — implement `listRecentMessages / sendText / sendImage / downloadResource / getUser`; for push-based IMs also implement `startListening / stopListening` (see `adapters/slack.js` for Socket Mode reference)
2. Add factory branch in `runtime/poll.js`: `if (im.type === '<im>') { ... }`; set `IM_MODE = 'polling'` (HTTP fetch loop) or `'push'` (WebSocket / callback) — push-mode messages **must emit even during mainBusy** (errors are permanent, no retry tick)
3. Set `im.type` in `profile.active.json` to the new IM name; optionally extend `DEFAULT_LOCALE_BY_IM` for system-message i18n
4. Add `skills/<im>-bot/SKILL.md` or extend existing one

<br/>

## Privacy Protection

Repo ships a pre-commit scanner that blocks real IM IDs (`cli_*` / `ou_*` / `oc_*` / `om_*`) / real-name blocklist / api-secret patterns from entering commits. One-time setup — see CLAUDE.md §Git 提交隐私防护.

<br/>

## Star History

<a href="https://star-history.com/#WaterTian/cc-bot&Date">
  <img src="https://api.star-history.com/svg?repos=WaterTian/cc-bot&type=Date" alt="Star History Chart" width="700" />
</a>

<br/>

---

<p align="center">
  <sub>MIT License &copy; <a href="https://github.com/WaterTian">Water</a></sub>
</p>
