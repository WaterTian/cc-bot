<!--
  cc-bot — Claude Code IM-bot plugin
  Develop project from group chat — by Claude Code. Lark/Feishu + Slack, IM-agnostic by design.
  Core: IMAdapter abstraction · Monitor + polling (HTTP 60s, lark; opt-in event push v0.1.49+) or Socket Mode push (Slack) · permission bridge (CC permission prompts → group) · statusline shim · interactive setup wizard · per-project profiles · i18n (zh-CN / en-US)

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
  <a href="https://www.npmjs.com/package/cc-bot"><img src="https://img.shields.io/npm/v/cc-bot?style=flat-square&color=cb3837&label=npm" alt="npm" /></a>
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

## Why CC-BOT? · 为什么做 CC-BOT？

**Problem** — Team members want to query and trigger project actions **from the group chat** ("what's the progress?" / "run tests" / "deploy staging" / "why did build fail?") without switching to terminals, dashboards, or ticket systems. Existing chat bots need bespoke backends per project and rarely integrate with an AI coding agent.

**Solution** — CC-BOT is a **Claude Code plugin** that listens to IM group messages, routes natural-language intents to **per-project actions** (you define them), runs them through Claude, and replies back. One plugin, any number of projects — each project's own `profile.intents` dict (intent → action description).

---

**问题** —— 团队希望**在群里**就能查询和触发项目操作（「进度怎么样？」「跑测试」「部署灰度」「构建为什么失败？」），而不用切到终端 / 仪表盘 / 工单系统。现有聊天机器人通常需要为每个项目定制后端，且很少与 AI 编程助手打通。

**方案** —— CC-BOT 是 **Claude Code 插件**：监听 IM 群消息，把自然语言意图路由到**项目特定动作**（由你定义），通过 Claude 执行，结果回到群里。一份插件、任意项目 —— 每个项目自己的 `profile.intents` 字典（意图 → 动作描述）。

> [!TIP]
> **Windows users:** Use `npm i -g @anthropic-ai/claude-code` instead of the native installer to avoid Bun memory crashes ([oven-sh/bun#25082](https://github.com/oven-sh/bun/issues/25082)). cc-bot's Monitor runs long-lived, amplifying Bun's memory pressure.
>
> **Windows 用户：** 建议用 `npm i -g @anthropic-ai/claude-code` 代替原生安装器，规避 Bun 内存崩溃；cc-bot 的 Monitor 是长驻进程，会放大 Bun 的内存问题。

> [!NOTE]
> **Sibling project: [SintBot](https://github.com/sintlab/sintbot), the standalone-daemon edition.** cc-bot runs inside the Claude Code session you already have open, on that session's model. SintBot runs on its own: no one has to keep a terminal open, it drives headless Claude Code or Codex, and each group gets its own project, model and permissions (Feishu, Slack, WeCom). PolyForm Shield · `npm i -g sintbot` · [sintbot.com](https://sintbot.com/?utm_source=cc-bot-readme)
>
> **姊妹项目：[SintBot](https://github.com/sintlab/sintbot/blob/main/README.zh-CN.md)（独立守护进程版）。** cc-bot 跑在你已经打开的 Claude Code 会话里，用的就是这个会话的模型；SintBot 自己常驻：不用有人守着终端，无头驱动 Claude Code 或 Codex，每个群各有项目、模型和权限（飞书、Slack、企业微信）。PolyForm Shield · `npm i -g sintbot` · [sintbot.com](https://sintbot.com/zh/?utm_source=cc-bot-readme)

<br/>

## Features

<table>
<tr>
  <td align="center" width="25%"><h3>●</h3><b>Streaming Cards</b><br/><sub>Lark CardKit v2 typewriter<br/>三态 header（蓝→绿/红）<br/>实时打字 + 耗时收尾</sub></td>
  <td align="center" width="25%"><h3>◨</h3><b>Interactive Setup</b><br/><sub>guided wizard · auto-detect IDs<br/>profile schema 自动 backfill</sub></td>
  <td align="center" width="25%"><h3>◐</h3><b>IM-agnostic</b><br/><sub>Lark · Slack<br/>capability-based adapter</sub></td>
  <td align="center" width="25%"><h3>◉</h3><b>Per-project Intents</b><br/><sub>JSON 自定义动作<br/>含 permission 分级</sub></td>
</tr>
<tr>
  <td align="center" width="25%"><h3>⊙</h3><b>Auto Redact</b><br/><sub>token / 真名 / 飞书 ID /<br/>邮箱 / 手机号 发群前强制 scrub</sub></td>
  <td align="center" width="25%"><h3>▣</h3><b>Crash-resistant</b><br/><sub>3-layer defense<br/>PID lock · EPIPE · state heal</sub></td>
  <td align="center" width="25%"><h3>⊕</h3><b>Code-driven</b><br/><sub>permission / intent / dispatch /<br/>redact 全代码化，prose 不膨胀</sub></td>
  <td align="center" width="25%"><h3>█▌</h3><b>HUD-aware</b><br/><sub>statusline shim · tees cc-hud<br/>5h 额度快满自动预警群里</sub></td>
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

- Line 1 — register the plugin source (GitHub repo). The same files are also published to npm as [`cc-bot`](https://www.npmjs.com/package/cc-bot) for mirrors and `npm view`; the marketplace remains the install path (there is no `npm i -g` setup)
- Line 2 — download to `~/.claude/plugins/cache/`. CC will pop a **scope selector**; pick one:

  | Option | When to use | Recommendation |
  |---|---|---|
  | `Install for you` (**user** scope) | You plan to use cc-bot across many projects | ✅ Daily use |
  | `Install for all collaborators` (**project** scope) | Team project, want teammates to auto-get cc-bot on clone | ✅ Team projects |
  | `Install for you, in this repo only` (**local** scope) | First-time try, don't pollute other projects | ✅ Quick try |

- Line 3 — hot-reload plugin list without restarting CC (new since CC 2.1.x; faster than `/exit` + re-open)
- Line 4 — enter the **interactive setup wizard** (lark-cli auto-install, OAuth login, chat picker via AskUserQuestion cards, config auto-fill)

> [!NOTE]
> If `/reload-plugins` is unavailable or `/cc-bot:*` commands still don't appear, fall back to `/exit` and relaunch Claude Code.

<br/>

## Updating

**v0.1.40+ 升级流程**（推荐，逐条执行）：

```
/cc-bot:stop                          # 若 bot 在跑
/plugin marketplace update cc-bot     # 打开插件面板并刷新 marketplace，从它装的插件会一并更新到新版（看到新版关闭面板即可）
/reload-plugins                       # 热加载新版到当前会话
/cc-bot:start                         # 内含 self-heal：profile schema backfill + Bash 权限补齐，老用户无感升级
```

> [!IMPORTANT]
> CC 的 `/plugin ...` 是**交互式命令**（会打开 Plugin Marketplace 面板），**不支持 shell `&&` 串联**，必须逐条等执行完再下一条。**没有 `/plugin update xxx` 这个斜杠命令**（未知子命令只会打开面板）：若面板 Installed 页里 cc-bot 仍是旧版，就在那里点 **Update now**，或在终端跑 `claude plugin update cc-bot@cc-bot` 后重启 CC。想真正 1 步省心 → 用下面 `> [!TIP]` 块里的 **autoUpdate** opt-in。

`/cc-bot:start` 启动前会自动跑 profile-migrate.js apply（v0.1.29+）+ Bash 权限完备度补齐（v0.1.38+ 同 setup §9 逻辑），都是**幂等纯加法**：无字段缺 / 无权限缺 = 静默；有补 = `ℹ self-heal: 补全 N 个字段 + M 条权限` 报告后正常启动。失败不阻塞 start。

完全省略了老的 `/cc-bot:setup` + `/cc-bot:doctor` 中间两步。

> [!TIP]
> **真正一键升级 — autoUpdate（可选 opt-in）** (v0.1.41+)
>
> 首次运行 `/cc-bot:setup` 时 wizard 会用 `AskUserQuestion` 卡问 "Enable autoUpdate?"，**默认 No 保守**；选 Yes 自动把以下片段 merge 进 `~/.claude/settings.json`：
>
> ```json
> {
>   "extraKnownMarketplaces": {
>     "cc-bot": {
>       "source": { "source": "github", "repo": "WaterTian/cc-bot" },
>       "autoUpdate": true
>     }
>   }
> }
> ```
>
> 配上 `/cc-bot:start` 的 self-heal，**升级不再需要打开插件面板**：
>
> 1. 新会话发出第一条消息后，CC 会在 10 分钟内自动把 cc-bot 拉到最新版并提示 `Plugin updated: cc-bot · Run /reload-plugins to apply` → 跑 `/reload-plugins`（不跑也行，下次重启 CC 就是新版）
> 2. `/cc-bot:start` → self-heal + 启动
>
> 后悔了想关 / 没装时想开 → 手工把 `autoUpdate` 改 `true`/`false` 即可，无需重跑 setup。

### 进阶：手工排查（旧流程，self-heal 失败时回退）

```
/cc-bot:setup     # 显式跑 profile-migrate + Bash 权限注册 + hooks 注册
/cc-bot:doctor    # 只读健康检查 — 版本漂移 / profile / 权限完备度 / lark-cli scope / agents.json schema
```

- **lark-cli scope 漂移**（v0.1.22+ 流式卡片要求 `cardkit:card:write` + `cardkit:card:read`）—— 升级 lark-cli 后必须 `lark-cli auth login --scope "cardkit:card:write cardkit:card:read"` 重新拿 token，否则 streaming card 调不动。`/cc-bot:doctor` 会显式检查这两个 scope。
- **Switching a project to Slack** (v0.1.12+) — install the SDK (`npm i -g @slack/socket-mode @slack/web-api`; cc-bot resolves it from npm's global directory, or `npm install` it inside the plugin folder), set `im.type: "slack"` in `.cc-bot/profiles/active.json` (or delete that file), then re-run `/cc-bot:setup` — the wizard only shows the IM picker when the profile has no `im.type`. One project = one IM.

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

## Quick Start — what `/cc-bot:setup` does · 快速开始

Setup prints a version banner (`cc-bot v<X.Y.Z> setup — <project>`), then runs through these steps — guided by `AskUserQuestion` cards, with IDs auto-detected wherever possible:

0. **Pick IM · 选 IM** — `lark` or `slack`. One project = one IM (switching needs profile rewrite).
1. **Detect tooling · 检测工具** — lark: auto-install `lark-cli` via `npm i -g @larksuite/cli`. slack: `runtime/slack-send.js check` verifies `@slack/socket-mode` + `@slack/web-api` can be loaded (`npm i -g @slack/socket-mode @slack/web-api` if missing — global installs are found automatically).
2. **Authenticate · 认证** — lark: OAuth Device Flow login (with app-creation checklist). slack: paste `templates/slack-manifest.yaml` into App's "From a manifest" form, then paste `xoxb-` Bot + `xapp-` App-Level tokens (scope `connections:write`).
3. **Pick target chat · 选目标群** — lark: list bot's chats via `AskUserQuestion` card or one-click create. slack: paste channel ID `C0xxx`; wizard probes + reminds `/invite @cc-bot`.
4. **Auto-detect IDs · 自动探测** — lark: `bot_app_id` / `admin_open_id` from `lark-cli auth list`. slack: `bot_user_id` from `auth.test`. Zero manual entry. One optional field stays empty: lark `im.bot_open_id` — leave it empty and **any @-mention (including @bot) is ignored** (conservative mode; plain messages still work); to make `@bot` work, have someone mention the bot once and copy `mentions[].id.open_id` from `lark-cli im +chat-messages-list` into the profile (setup prints the exact command).
5. **Write config · 写配置** — `.cc-bot/profiles/active.json` (IM-branched fields) + `state.json` + `.gitignore`. Locale defaults: `zh-CN` (lark) / `en-US` (slack); override via `im.locale`.
6. **Register statusline shim · 注册 shim** — tees stdin JSON to `hud-stdin.json` (for bot's HUD intent, quota alert and stall alert) + cc-hud rendering if installed.
6b. **Register hooks · 注册 hooks** — merges three hook sets into the global `~/.claude/settings.json` (never overwrites other keys): `UserPromptSubmit` / `Stop` → `main-busy.js` (terminal-first lock), `PreToolUse` → `todo-bridge.js` (todo progress mirrored to the streaming card), `PermissionRequest` → `permission-bridge.js` (permission prompts to the group, inert until `permission_bridge.enabled`). Also asks once whether to enable marketplace `autoUpdate` (default No).
7. **Register permission set · 注册权限集** (v0.1.38+) — append IM-specific wildcards (`runtime/*.js` · plugin-cache `Read/Edit/Write` · `lark-cli *` · `npm install -g @larksuite/cli*` / `@slack/*` · `curl api.github.com`) to `<project>/.claude/settings.local.json`. **Strictly additive + idempotent** — never overwrites existing rules.

Every step is **idempotent** — rerun safely. Then **`/cc-bot:start`** — bot online in ≤ 5s.

<br/>

## How It Works

```
Main session ── Monitor(persistent) ── node poll.js ── lark: every 60s IMAdapter.listRecentMessages()  (default)
                                                       lark: `lark-cli event consume` long-connection push + 5min reconcile  (im.transport='push', v0.1.49+)
                                                       slack: Socket Mode WebSocket push (event-driven)
                                                    ├─ dedupe via state.last_processed_time + poll.emitted
                                                    └─ stdout: NEW_MSG|msg_id|sender|text|ts[|FLAGS=…][|CHAT=<chat_id>]
                                                               ↓ Monitor → notification
                                                         main session → permission.js check → intent.js resolve
                                                                      → dispatch.js register（slot/tags/serial）
                                                                      → spawn worker subagent
                                                                            ↓
                                                worker → streaming-card.js report（lark）
                                                       → slack-send.js send-text（slack）
                                                       → redact.js 自动脱敏（两路径强制）
```

<table>
<tr>
  <td align="center"><b>Polling or event push (lark)</b><br/><sub>60s HTTP polling default · opt-in long-connection push<br/>(quota-free, auto-fallback)</sub></td>
  <td align="center"><b>Socket Mode push (slack)</b><br/><sub>WebSocket event-driven<br/>mainBusy still emits</sub></td>
  <td align="center"><b>3-layer defense</b><br/><sub>PID lockfile · EPIPE self-kill<br/>state future-value heal</sub></td>
  <td align="center"><b>Per-project isolation</b><br/><sub>.cc-bot/ per project<br/>zero cross-contamination</sub></td>
</tr>
</table>

### Code-driven decisions（v0.1.22+ runtime/）

| 工具 | 用途 |
|---|---|
| `runtime/streaming-card.js` | Lark CardKit v2 流式卡片 driver — 单一 `report` 入口，CLI 内部按 profile + 内容形态自动选 卡片 / 文本 / 降级 reply，自动脱敏。v0.1.36+ `state.lastContentHash` sha1 dedup 跳过同 content 重复 patch |
| `runtime/streaming-card-policy.js` | v0.1.35+ `canUseStreamingCard(profile)` 单一事实源，被 streaming-card / dispatch / todo-bridge 共用，去重 3 处 inline `im.type + enabled` 判断漂移 |
| `runtime/atomic-write.js` | v0.1.36+ 原子写 helper（tmp + fsync + rename + cleanup）— 全 runtime 状态文件（`agents.json` / `stream-*.json` / `poll.busy-held` / profile / 等 8 处）crash-safe |
| `runtime/permission.js` | 角色判定 + intent level 映射（`public` / `admin` / `admin-confirm` / `group-rejected`），含高危名字防御启发式 |
| `runtime/intent.js` | intent 解析：占位符替换（`<project.root>` / `<paths.bot_temp_abs>` 等）+ 动态可用清单（doc_progress 文件存在校验）|
| `runtime/redact.js` | 文本脱敏（slack token / Bearer / JWT / `app_secret=*` / 飞书 cli_/ou_/om_ ID / 邮箱 / 手机号 / blocklist 真名）—— lark + slack 发群入口强制调 |
| `runtime/slack-send.js` | v0.1.12+ Slack Web API 跨平台 helper，规避 Win curl GBK 乱码 + token 暴露；自动 redact |
| `runtime/ack-detect.js` | 短消息 ACK 语义判定（yes / continue / ok / thanks + 停止词否决）+ 推荐回复 |
| `runtime/dispatch.js` | agents.json 调度生命周期（evaluate / register / complete / **sweep**）— tags 冲突 + slot + 同 user 串行全代码化。v0.1.33+ register 同步预热流式卡片（首帧 6-10s → 1-2s）；v0.1.35+ register 响应带 `preheated:bool` 让 SKILL.md 一行判要不要回群占位；v0.1.37+ `sweep` 子命令按 `profile.dispatch.max_turn_time_mins`（默认 0=不启用）回收超时 running + 释放 slot + agents.json `version` 字段 CAS 防 lost update |
| `runtime/profile-migrate.js` | 版本化 profile schema migration — 升级时自动 backfill 历史新增字段，不覆盖用户已设值 |
| `runtime/quota-alert.js` | v0.1.47+ Claude 5h 额度预警 — 读 HUD 的 `rate_limits.five_hour`，跨 85 / 95 / 耗尽 三档各发群一条 ≤2 行提示（`resets_at` 当窗口键去重，窗口滚动自动清零 + 补发「已恢复」）。耗尽期群消息走 `busy-held` 暂存不 emit，恢复后补推。判定放 poll.js 是因为它是独立进程**不吃额度**，额度耗尽时唯一还能开口的组件。开关 / 阈值见 `profile.quota_alert`（默认开，85 / 95）|
| `runtime/permission-bridge.js` | v0.1.49+ CC `PermissionRequest` hook — 主会话弹「允许 / 拒绝」权限框时转发到群：`notify`（单向提示）或 `approve`（`members.admin_open_ids` 回「允许 <id>」/「拒绝 <id>」代答 CC，超时交回终端 = fail-closed）。默认关；远端只能本次允许、不写 always-allow；每次决策写 events.log 审计；管理员回复 id 写入 `poll.emitted` 不会被当新任务 |
| `runtime/stall-alert.js` | v0.1.50+ 主会话假死告警 — emit 后 `heartbeat.stall_mins` 内 HUD 心跳 / `agents.json` / 群内 bot 发言 三路本地信号都没动 → 发群「似乎卡住了」+ 终端 BOT_WARN，恢复补「已恢复」；默认关，零额外 API |
| `adapters/factory.js` | v0.1.49+ `createAdapter(profile)` 单一入口，poll.js / permission-bridge.js 共用字段校验 + 实例化 |
| `runtime/todo-bridge.js` | v0.1.32+ CC `PreToolUse` hook bridge — 主会话调 TodoWrite / TaskCreate / TaskUpdate 时自动 diff todos 变化 → spawn streaming-card.js 把进度（▸ 进行中 / ✓ 完成）推到当前 running 任务的卡片，**worker 端零负担**（hook 异步 detached 不阻塞主会话）|

**设计原则**：决策、转换、状态管理代码化，prose（SKILL.md / worker.md）只描述"调哪个命令、按返回 action 走"，**LLM 推理负担和文档膨胀双降**。

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
| `/cc-bot:poll-once` | One polling round (`poll.js --once`), driven by `/loop` — only for `polling_mode = self-poll` endpoints that cannot host `Monitor` |

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
  },
  "intent_permissions": {
    "deploy": "admin",
    "drop_data": "admin-confirm"
  }
}
```

`intent_permissions`（v0.1.23+，可选）声明每个 intent 的权限级别：

- `public` — 任何群成员可触发（默认）
- `admin` — 仅 `members.admin_open_ids` 白名单可执行
- `admin-confirm` — 即使 admin 也需口头确认一次（破坏性操作）
- `group-rejected` — 群里发一律拒（bot 开关类）

未声明的项目 intent，**名字含 `deploy` / `publish` / `release` / `drop_*` / `delete_*` / `reset_*` / `restart_*` / `prod*` 等高危词时自动默认 `admin`**（防 legacy profile 把生产操作意外公开），其他默认 `public`。

Works for **any project type** — Web / mini-program / Node service / Python data pipeline / mobile app. If you can script it, you can intent-route it.

<br/>

## Prerequisites

- **Claude Code** — uses `Skill` / `Monitor` / `TaskStop` / `AskUserQuestion` tools
- **For lark**: `npm i -g @larksuite/cli` + `lark-cli auth login` (setup wizard will guide this)
- **For slack**: `npm i -g @slack/socket-mode @slack/web-api` (cc-bot finds global installs; or `npm install` them inside the plugin folder) + create an App at api.slack.com/apps via the `templates/slack-manifest.yaml` (setup wizard will guide token paste-in)
- **Shell** — **Windows**: Git Bash required (cmd.exe / PowerShell mangle special characters in argv); **macOS / Linux**: system bash works out of the box
- **Optional: cc-hud** — prettier status bar: `/plugin marketplace add WaterTian/cc-hud` then `/plugin install cc-hud@cc-hud`; cc-bot's statusline shim tees it automatically

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

1. Add `adapters/<im>.js` extending `IMAdapter` (see `adapters/base.js`) — implement `listRecentMessages / sendText / sendImage / downloadResource / getUser / addReaction`; for push-based IMs also implement `startListening / stopListening` (see `adapters/slack.js` for Socket Mode reference)
2. Add a branch in `adapters/factory.js` (`createAdapter`) — poll.js and permission-bridge.js both instantiate through it; in `runtime/poll.js` pick `IM_MODE = 'polling'` (HTTP fetch loop) or `'push'` (WebSocket / callback) — push-mode messages **must emit even during mainBusy** (errors are permanent, no retry tick). Every normalized message must carry `chatId`
3. Set `im.type` in `profile.active.json` to the new IM name; optionally extend `DEFAULT_LOCALE_BY_IM` in `adapters/factory.js` (`resolveLocale`) for system-message i18n
4. Add `skills/<im>-bot/SKILL.md` or extend existing one

<br/>

## Multiple Groups — `im.chat_ids` (v0.1.51+)

One project can serve several groups (issue #24). Keep `im.chat_id` as the **primary** group and list the others in `im.chat_ids`:

```json
"im": { "chat_id": "oc_primary…", "chat_ids": ["oc_second…", "oc_third…"] }
```

| Behaviour | Multi-group rule |
|---|---|
| Polling | poll.js fetches every group each tick (≈1 billed call per group per tick); one group failing only logs `BOT_WARN|poll.js|poll-chat-failed`, the others keep working |
| Cursors | **one cursor per group** in `.cc-bot/runtime/poll.cursors.json`, advanced by poll.js on emit. A single global cursor would drop a message from group B that was sent earlier than, but fetched after, a message from group A — exactly the silent loss reported in #24. New groups start from the global `last_processed_time` so history is not replayed |
| Envelope | every `NEW_MSG` ends with `\|CHAT=<chat_id>`; the main session replies and does its fetch-before-reply check in **that** group. Single-group envelopes are unchanged |
| Push (`im.transport: "push"` / Slack) | one event stream, filtered by the configured set; lark events without a `chat_id` are dropped (fail-closed) and warned once; a Slack event without `channel` falls back to the primary group |
| Proactive messages | busy placeholder and stall alert go to the group that triggered them; quota alerts are broadcast to all groups; `/cc-bot:start` / `stop` notify every group; the permission bridge stays on the primary group |
| Upgrade safety | the array lives in the profile, not in a patched plugin file, so a plugin update can no longer silently turn the second group off; `/cc-bot:doctor` §2 validates the list |

Add the field, then `/cc-bot:stop` + `/cc-bot:start`. `im.chat_ids: []` (the default) keeps the old single-group behaviour byte-for-byte.

<br/>

## Lark Transport — polling vs event push (v0.1.49+)

Feishu's free tier meters **tenant-wide** API calls (1M / month, shared by every self-built app). Polling bills ≥1 call per tick even when nobody talks; **event subscriptions are not metered**.

| `im.transport` | How messages arrive | Idle cost | When to use |
|---|---|---|---|
| `""` / `"polling"` (default) | `lark-cli im +chat-messages-list` every `polling_interval_ms` (60s) | ≈1440 calls/day | Works everywhere, including behind VPN proxies |
| `"push"` | `lark-cli event consume im.message.receive_v1` long connection, real-time, plus a `push_reconcile_interval_ms` (5min) catch-up poll | ≈288 calls/day | Lower quota + lower latency; one event bus per app globally |

Enable: set `im.transport: "push"` in `.cc-bot/profiles/active.json`, then `/cc-bot:stop` + `/cc-bot:start`. If the long connection cannot start (another host already holds this app's event bus, missing scope, not logged in) or drops for good, poll.js **falls back to polling automatically** and prints `BOT_INFO|poll.js|push-fallback|<reason>` — service never stops. `/cc-bot:doctor` §3.6 shows which transport is live.

> [!NOTE]
> Feishu allows **one event bus per app**. If the same bot app runs cc-bot on several machines, only one of them may use `push`; the others stay on polling (the conflict is detected and reported, not silently split).

<br/>

## Permission Bridge — CC permission prompts in the group (v0.1.49+)

When the main session hits a tool that is not in the allow list, Claude Code shows an **Allow / Deny** dialog and waits for someone at the terminal. With a remote team that means the bot just goes quiet. The permission bridge is a CC `PermissionRequest` hook (`runtime/permission-bridge.js`, registered by `/cc-bot:setup`) that forwards the prompt to the chat:

```json
"permission_bridge": { "enabled": true, "mode": "approve", "wait_secs": 90 }
```

| `mode` | Behaviour |
|---|---|
| `notify` | One-way: posts `🔐 需要授权 #ab12 · 工具 · 内容`, the terminal dialog still decides |
| `approve` | Two-way: an admin (`members.admin_open_ids`) replies `允许 ab12` / `拒绝 ab12` (or `allow` / `deny`) and the hook answers CC; no reply within `wait_secs` → hands back to the terminal (fail-closed). Generic acks (`ok` / `yes` / `1` / `好`) only count when the `#id` is included, so a casual "ok" to a colleague never approves a tool call |

Guard rails: default **off**; only admins are honoured; remote approval is **this call only** (never writes an always-allow rule); every decision is audited in `.cc-bot/runtime/events.log`; the prompt text is redacted before posting (unknown / MCP tools show only whitelisted fields); the admin's reply is consumed by the hook **and** recognised by poll.js itself, so it is never treated as a new task even in push mode. With multiple groups the bridge uses the primary `im.chat_id` only. Live test without CC (it really posts one prompt to the group and waits for a reply): `node <plugin>/runtime/permission-bridge.js probe --project <root> --mode approve --wait 60`.

<br/>

## Stall Alert — active heartbeat for a hung main session (v0.1.50+)

`/cc-bot:doctor` and `events.log` are passive: when the main session hangs, nobody is at the terminal to run them, and the group only sees a bot that stopped talking (issue #4). The stall alert lives in poll.js, a separate process that keeps running when the main session does not:

```json
"heartbeat": { "stall_mins": 10, "notify_recovered": true }
```

After poll.js hands a group message to the main session it watches three **local** signals: the statusline heartbeat (`hud-stdin.json` mtime), the dispatch ledger (`agents.json` mtime) and the bot's own replies in the chat. If none of them moves for `stall_mins`, it posts `⚠️ 主会话似乎卡住了：N 分钟前收到的群消息还没被处理…` to the group, prints `BOT_WARN|poll.js|stall-suspected` in the terminal and logs it; once the session moves again it posts `✅ 主会话已恢复响应`. Zero extra API calls. Off by default (`stall_mins: 0`); silent while a terminal user holds the main-busy lock (the busy placeholder already covers that); re-reminds at most every 30 min; needs the statusline shim (`/cc-bot:setup` installs it, doctor §3.8 / §5 check it).

<br/>

## Privacy Protection

**两层防御**：

**① Runtime auto-redact（v0.1.24+）** — `runtime/redact.js` 在所有发群路径（`streaming-card.js report` / `slack-send.js send-text`）入口自动过一遍 scrub：

| 敏感串类型 | 替换为 |
|---|---|
| Slack token (`xoxb-*` / `xapp-*`) | `<redacted:slack_xoxb>` / `<redacted:slack_xapp>` |
| Bearer / JWT / `app_secret=*` / `api_key=*` | `<redacted:bearer>` / `<redacted:jwt>` / `<redacted:secret_kv>` |
| 飞书 ID (`cli_*` / `ou_*` / `om_*`) | `<redacted:lark_app_id>` / `<redacted:lark_open_id>` / `<redacted:lark_msg_id>` |
| 邮箱 / 中国手机号 | `<redacted:email>` / `<redacted:phone_cn>` |
| `profile.privacy.blocklist` 自定义真名 | `<同事>`（可改 `blocklist_replace`）|

worker 不需要手动调；所有携带用户内容的**代码发群路径**（worker 卡片 / 文本、slack-send、权限桥摘要）强制脱敏；额度 / 假死告警只发固定模板文案，不含用户内容。主会话 inline 用 `lark-cli im +messages-reply` 直接回的短消息由 LLM 按 SKILL 规则自律，不经代码脱敏。

**② Pre-commit hook（开发本仓库时装）** — 阻塞真实 IM ID / 黑名单真名 / api-secret 进 git commit。一次性 setup 见 CLAUDE.md §Git 提交隐私防护.

<br/>

## Star History

<a href="https://star-history.com/#WaterTian/cc-bot&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=WaterTian/cc-bot&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=WaterTian/cc-bot&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=WaterTian/cc-bot&type=Date" width="700" />
  </picture>
</a>

<br/>

---

<p align="center">
  <sub>MIT License &copy; <a href="https://github.com/WaterTian">Water</a></sub>
</p>
