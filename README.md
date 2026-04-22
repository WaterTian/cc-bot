<!--
  cc-bot — Claude Code IM-bot plugin
  Turns any IM group into an AI project assistant. Lark/Feishu first, IM-agnostic by design.
  Core: IMAdapter abstraction · Monitor + polling (HTTP 30s, WS-proxy-safe) · statusline shim · interactive setup wizard · per-project profiles

  ## Auto-install (for Claude Code AI agents)
  Step 1: /plugin marketplace add WaterTian/cc-bot
  Step 2: /plugin install cc-bot@cc-bot   (CC will prompt for scope; pick "local" for quick try, "project" for team share, "user" for global)
  Step 3: /reload-plugins   (or /exit + re-launch claude)
  Step 4: /cc-bot:setup   (interactive wizard — auto-installs lark-cli, OAuth login, chat picker, config auto-fill)

  Keywords: claude-code plugin bot im lark feishu group-chat ai-assistant monitor polling intents statusline hud windows zero-runtime-dep
-->

<h1 align="center">CC-BOT</h1>

<p align="center">
  <strong>Turn any IM group into an AI project assistant, powered by <a href="https://claude.ai/claude-code">Claude Code</a></strong><br/>
  <sub>把任意 IM 群变成 AI 项目助手，由 Claude Code 驱动</sub>
</p>

<p align="center">
  <code>IM group</code> &nbsp;&rarr;&nbsp; <code>Monitor</code> &nbsp;&rarr;&nbsp; <code>Intent</code> &nbsp;&rarr;&nbsp; <code>Claude acts</code> &nbsp;&rarr;&nbsp; <code>Chat reply</code>
  <br/>
  <sub>natural-language command → per-project action → report back to group.</sub>
</p>

<p align="center">
  <a href="#install"><img src="https://img.shields.io/badge/install-3_commands-blueviolet?style=flat-square" alt="install" /></a>
  &nbsp;
  <img src="https://img.shields.io/badge/im-lark%20%C2%B7%20extensible-blue?style=flat-square" alt="im" />
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

<br/>

## Features

<table>
<tr>
  <td align="center" width="20%"><h3>⚙</h3><b>Interactive Setup</b><br/><sub>5-stage wizard<br/>auto-detect IDs</sub></td>
  <td align="center" width="20%"><h3>🔌</h3><b>IM-agnostic</b><br/><sub>Lark today<br/>adapter pattern</sub></td>
  <td align="center" width="20%"><h3>📣</h3><b>Per-project Intents</b><br/><sub>JSON-defined<br/>Claude executes</sub></td>
  <td align="center" width="20%"><h3>🛡</h3><b>Crash-resistant</b><br/><sub>3-layer defense<br/>PID lock · EPIPE · state heal</sub></td>
  <td align="center" width="20%"><h3>🎚</h3><b>HUD-aware</b><br/><sub>statusline shim<br/>tees cc-hud if installed</sub></td>
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
> 若 `/reload-plugins` 不可用或命令表仍没出现 `/cc-bot:*`，退一步 `/exit` 重开 Claude Code 即可。

<br/>

## Updating

When a new release is announced, run these in **each project** using cc-bot:

```
/plugin marketplace update cc-bot    # refresh manifest (detects new version)
/plugin update cc-bot@cc-bot         # fetch new version into cache
/reload-plugins                      # apply in current session
/cc-bot:doctor                       # verify: first line prints "cc-bot v<new-version>"
```

- **Before upgrading** — run `/cc-bot:doctor` first; it compares installed version with the latest GitHub release and prints the upgrade hint if drifted, plus flags stale permissions or profile issues.
- **After upgrading** — run `/cc-bot:doctor` again to confirm the new version is active; or run `/cc-bot:start` and the group online notification will show `cc-bot v<new-version> 已上线`. Setup's greeting + completion lines also carry `v<version>` (since v0.1.4) for the same reason.

### Stable permission pattern (auto-registered since v0.1.3)

CC's plugin cache is version-indexed (`~/.claude/plugins/cache/cc-bot/cc-bot/<version>/`). After each upgrade the Monitor launch path points to a new version dir, so CC would otherwise re-prompt for permission.

**Since v0.1.3**, `/cc-bot:setup` auto-writes the following wildcard rule to `<project>/.claude/settings.local.json`:

```
Bash(node C:/Users/*/.claude/plugins/cache/cc-bot/cc-bot/*/runtime/poll.js --project *)
```

You won't be prompted for Monitor on any future version upgrade.

**For v0.1.2 or earlier installs** (pre-auto): after you update to v0.1.3+, re-run `/cc-bot:setup` — step 9 is idempotent and will append the rule. Or add it manually.

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

The wizard is fully interactive (AskUserQuestion cards, no blind typing). It walks through 6 stages:

1. **Detect lark-cli** — auto-install via `npm i -g @larksuite/cli` if missing
2. **OAuth login** — guide you through Lark Open Platform app creation (scope checklist provided), then browser Device Flow login
3. **Pick target chat** — list bot's chats via `AskUserQuestion` card; or one-click create a new chat (bot auto-joins, you become owner)
4. **Auto-detect IDs** — `bot_app_id` / `admin_open_id` pulled from `lark-cli auth list`, zero manual entry
5. **Write config** — generate `.cc-bot/profiles/active.json` + `state.json` + pre-filled `member-cache.json` + `.gitignore`
6. **Register statusline shim** — tees stdin JSON to `hud-stdin.json` (for bot's HUD intent) + cc-hud rendering (if installed, for status bar)

Each stage is **idempotent** — rerun `/cc-bot:setup` anytime, it skips what's already done.

Then **`/cc-bot:start`** (or just say "开bot" / "start bot" in the main session) — bot comes online in ≤ 5s.

<br/>

## How It Works

```
Main session ── Monitor(persistent) ── node poll.js ── every 30s: IMAdapter.listRecentMessages()
                                                    ├─ dedupe via state.last_processed_time + poll.emitted
                                                    └─ stdout: NEW_MSG|msg_id|sender|text|ts
                                                               ↓ Monitor → notification
                                                         main session → intent routing → adapter.sendText

CC's statusLine ── cc-bot shim ── write hud-stdin.json (for bot's HUD intent)
                                └─ tee cc-hud (optional, for status bar rendering)
```

<table>
<tr>
  <td align="center"><b>HTTP polling</b><br/><sub>30s fixed interval<br/>VPN-proxy safe<br/>no WS disconnect</sub></td>
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
- **lark-cli** — `npm i -g @larksuite/cli` + `lark-cli auth login` (setup wizard will guide this)
- **Git Bash on Windows** — poll.js adapter uses bash shell to pass argv safely (cmd.exe mangles special characters)
- **Optional: cc-hud** — install for prettier status bar (`/plugin install cc-hud@WaterTian-cc-hud`); cc-bot shim tees it automatically

<br/>

## 快速开始（中文）

在目标项目里运行 **`/cc-bot:setup`**，交互式向导会：

1. **检测 lark-cli** — 未装自动 `npm i -g @larksuite/cli`
2. **OAuth 登录引导** — 带你去飞书开放平台建应用（附必需 scope 清单），完成浏览器 Device Flow 登录
3. **选目标群** — 用 `AskUserQuestion` 卡片列 bot 所在群，或一键新建（bot 自动入群、你成为群主）
4. **自动探测 ID** — `bot_app_id` / `admin_open_id` 从 `lark-cli auth list` 直接取，不用手填
5. **写配置** — 生成 `.cc-bot/profiles/active.json` + `state.json` + 预填 `member-cache.json` + `.gitignore`
6. **注册 statusline shim** — 落盘 stdin JSON（给 bot 用）+ 可选透传 cc-hud（渲染状态栏）

然后 **`/cc-bot:start`**（或主会话直接说「开bot」）。

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

cc-bot ships with Lark. Adding WeCom / DingTalk / Slack / Discord / etc:

1. Add `adapters/<im>.js` extending `IMAdapter` (see `adapters/base.js`) — implement `listRecentMessages / sendText / sendImage / downloadResource / getUser`
2. Add factory branch in `runtime/poll.js`: `if (im.type === '<im>') { ... }`
3. Set `im.type` in `profile.active.json` to the new IM name
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
