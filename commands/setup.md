---
name: setup
description: End-to-end cc-bot bootstrap — choose IM (lark/slack), guide app/channel setup, collect tokens or auto-detect IDs, write active.json
---

Bootstrap cc-bot for the **current project** (the directory where the user runs Claude Code). This command is **idempotent** — each stage checks state and skips when already done.

Run all bash commands with `LARK_CLI_NO_PROXY=1` prefix to avoid vpn/proxy issues with lark-cli.

---

## Preamble — 报版本

在进入 Stage 0 前，Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` 拿 `version`，向用户输出一行开场：

```
cc-bot v{version} setup — {当前项目目录名}
```

目的：用户一眼知道当前跑的 cc-bot 版本，遇到问题报 issue 时附上这行即可。

---

## Stage 0 — 选择 IM 工具

cc-bot 当前支持两个 IM adapter：**飞书（lark）** 和 **Slack**。用 AskUserQuestion 让用户选：

```
AskUserQuestion({
  questions: [{
    question: "选择 cc-bot 接入的 IM 工具",
    header: "IM",
    multiSelect: false,
    options: [
      { label: "飞书 / Lark (Recommended)", description: "中文场景默认；通过 lark-cli 收发消息；polling 模式" },
      { label: "Slack", description: "英文场景默认；Socket Mode push；需 api.slack.com 建 App" }
    ]
  }]
})
```

- 选「飞书」→ 设 `IM_TYPE = lark`，按本文档原 Stage A → B → D → E 走
- 选「Slack」→ 设 `IM_TYPE = slack`，**跳过 Stage A**（无 CLI 需装），直接走 Stage B-slack → D-slack → E（Stage E 字段按 IM_TYPE 分流）

后续命令模板 / 字段格式按 IM_TYPE 分支选择；共享部分（statusline shim / main-busy hook / Monitor 通配权限 / gitignore）两边都跑。

## Stage A — lark-cli 安装（仅 `IM_TYPE = lark`，Slack 跳过本 Stage）

1. Run `lark-cli --version`.
2. If the command fails / not found:
   - Tell the user: `未检测到 lark-cli，自动安装（npm i -g @larksuite/cli）...`
   - Run `npm i -g @larksuite/cli`. If it fails, report the error and stop; ask user to fix npm/node and re-run `/cc-bot:setup`.
   - Re-run `lark-cli --version` to confirm.
3. Tell the user: `✓ lark-cli {version} 已安装`

## Stage B — 应用准备 + lark-cli 登录（仅 `IM_TYPE = lark`）

Run `lark-cli auth list` once — **不要加 `--format json` flag**（该子命令默认输出 JSON，加 flag 会 `Error: unknown flag: --format` 失败）。Based on the output branch:

**Non-empty JSON array（已登录）**: extract first entry — `appId` → **BOT_APP_ID**, `userOpenId` → **ADMIN_OPEN_ID**, `userName` → **ADMIN_NAME**. Tell user `✓ 已登录 {ADMIN_NAME}（{BOT_APP_ID}）`. Skip to Stage D.

若 auth list 返回**多个** entry（用户之前登录过不同 app），用 AskUserQuestion 让用户选：
```
AskUserQuestion({
  questions: [{
    question: "检测到多个已登录应用，选一个给 cc-bot 用",
    header: "应用",
    multiSelect: false,
    options: [
      { label: "{userName_1} - {appId_1}", description: "open_id: {userOpenId_1}" },
      { label: "{userName_2} - {appId_2}", description: "open_id: {userOpenId_2}" },
      // 最多 4 个，>4 时只列前 3 + 一项 "其他（回复 appId）" 回退到文字
    ]
  }]
})
```

**Empty `[]`（首次用户）**: 走手动引导 → 登录两步。先显示这份清单 + 等用户回「继续」：

```
在飞书开放平台创建自建应用：

1. 打开 https://open.feishu.cn/app → 「创建企业自建应用」→ 填名字保存
2. 左侧「权限管理」启用以下权限（缺一不可，名字以平台当前版本为准）：
   - im:message                           发消息
   - im:message:send_as_bot
   - im:message:readonly                  读群消息
   - im:chat:read / im:chat:readonly      读群列表（不同版本名字略有差异，勾类似项即可）
   - im:chat.members:read                 读群成员
   - im:chat / im:chat.members:write      建新群 + 拉成员（Stage D 新建群需要）
   - im:resource                          下载图片/文件
   - contact:user.base:readonly           查 open_id → name
   - contact:user.basic_profile:readonly
3. 左侧「应用发布」→ 发布「企业自建应用」→ 等管理员审批通过
```

展示指引后用 **AskUserQuestion** 问确认：
```
AskUserQuestion({
  questions: [{
    question: "飞书应用已创建并发布？",
    header: "应用准备",
    multiSelect: false,
    options: [
      { label: "已完成，继续 (Recommended)", description: "应用已审批通过" },
      { label: "取消 setup", description: "稍后准备好再跑 /cc-bot:setup" }
    ]
  }]
})
```

选「已完成」→ 显示登录命令：`请在终端跑 lark-cli auth login 完成浏览器 Device Flow 授权`，再用一次 AskUserQuestion 等确认：
```
AskUserQuestion({
  questions: [{
    question: "lark-cli auth login 完成？",
    header: "登录状态",
    multiSelect: false,
    options: [
      { label: "已登录，继续 (Recommended)", description: "lark-cli auth list 应能看到刚才的 appId" },
      { label: "取消 setup", description: "" }
    ]
  }]
})
```

选「已登录」→ 跑 `lark-cli auth list` 解析 BOT_APP_ID / ADMIN_OPEN_ID / ADMIN_NAME，继续 Stage D。

**备注：**
- `tokenStatus: needs_refresh` 不阻塞 — lark-cli 在下一次真正调 API 时会自动 refresh。若下游命令报 token expired，按提示 `lark-cli auth login` 重登即可
- **scope 不在此处硬校验** — 应用 scope 由飞书开放平台「权限管理」页配置（上面清单），`lark-cli auth scopes` 查到的是 user 授权 scope 而非 app scope。若 scope 未配齐，Stage D 列群或后续发消息会报错，用户按 lark-cli 错误提示回开放平台补即可
- **拉 bot 入群**不放 Stage B 硬要求 — Stage D 会列出 bot 所在群，若空则同一步引导用户拉 bot 或新建群

## Stage B-slack — Slack App 创建 + token 输入（仅 `IM_TYPE = slack`）

Slack 没有飞书 lark-cli 那种 OAuth Device Flow，需要用户手工去 api.slack.com 建 App。本 Stage 引导走完整套路。

### Step 1 — 提供 manifest + 引导建 App

Read `${CLAUDE_PLUGIN_ROOT}/templates/slack-manifest.yaml` 整段内容，贴给用户加说明：

```
我已经准备好 cc-bot 的 Slack App manifest YAML（含所需 scopes + Socket Mode 开关）：

<把 templates/slack-manifest.yaml 内容整段贴出>

接下来你做以下事：
1. 浏览器打开 https://api.slack.com/apps
2. 点「Create New App」→「From a manifest」
3. 选择目标 workspace
4. 把上面 manifest YAML 整段粘贴 → Next → Create
5. 在 App 详情页 Basic Information 段：
   a.「App-Level Tokens」→「Generate Token and Scopes」
      Token Name: `cc-bot-socket`
      Add Scope: `connections:write`
      点 Generate → 复制生成的 xapp- token
6. 左侧「Install App」→「Install to Workspace」→ Allow → 复制 Bot User OAuth Token (xoxb-)
```

用 AskUserQuestion 等用户确认：

```
AskUserQuestion({
  questions: [{
    question: "Slack App 已创建并拿到 xapp- / xoxb- 两个 token？",
    header: "App 准备",
    multiSelect: false,
    options: [
      { label: "已完成，继续 (Recommended)", description: "我已生成 App-Level Token 和 Bot Token" },
      { label: "取消 setup", description: "稍后准备好再跑 /cc-bot:setup" }
    ]
  }]
})
```

### Step 2 — 收 Bot Token

告诉用户：`请粘贴 Bot User OAuth Token（xoxb- 开头，单条消息回复即可）`。等文字输入，存为 **BOT_TOKEN**。校验格式 `^xoxb-[A-Za-z0-9-]{20,}$`；不符报错让重粘。

### Step 3 — 收 App Token

告诉用户：`请粘贴 App-Level Token（xapp-1- 开头）`。等文字输入，存为 **APP_TOKEN**。校验格式 `^xapp-1-[A-Z0-9]+-[0-9]+-[a-f0-9]+$`。

### Step 4 — 验证 + 拿 bot_user_id

调用 Slack `auth.test` 验证 token（此时 active.json 还没建，不能用 slack-send.js；直接 curl）：

```bash
curl -s -H "Authorization: Bearer ${BOT_TOKEN}" https://slack.com/api/auth.test
```

解析返回 JSON：
- `ok=true` → 提取 **BOT_USER_ID** (`user_id`, U0xxx) + **BOT_NAME** (`user`) + **WORKSPACE_NAME** (`team`)
- `ok=false` → 报错 `Bot token 无效（{error}）`，回 Step 2 让用户重粘

Tell user: `✓ token 有效 — Workspace: {WORKSPACE_NAME}, Bot: {BOT_NAME} ({BOT_USER_ID})`，继续 Stage D-slack。

## Stage D — 选群 + 拿 chat_id（仅 `IM_TYPE = lark`）

1. Run `LARK_CLI_NO_PROXY=1 lark-cli im chats list --as bot --format json`.
2. Parse `data.items[]` from the JSON envelope. Each item has `chat_id` + `name`. Let **N** = item count.

3. **If N == 0**: skip directly to sub-flow **D.new** (no selection UI — bot isn't in any chat yet so there's nothing to pick from).

4. **If 1 ≤ N ≤ 3**: show a selection UI with existing chats + "新建一个群" as the last option (total options = N + 1, always ≤ 4, fits AskUserQuestion). **Always include "新建一个群" — never auto-select even when N == 1.**

   Example for N == 2:
   ```
   AskUserQuestion({
     questions: [{
       question: "选择 bot 监听的目标群",
       header: "目标群",
       multiSelect: false,
       options: [
         { label: "{chat_name_1}", description: "chat_id: {chat_id_1}" },
         { label: "{chat_name_2}", description: "chat_id: {chat_id_2}" },
         { label: "新建一个群", description: "自动创建新群并把你加为群主" }
       ]
     }]
   })
   ```

   Decision on response:
   - User picked an existing chat → record **CHAT_ID** / **CHAT_NAME** from that option, proceed to Stage E.
   - User picked **新建一个群** → go to **D.new**.

5. **If N ≥ 4**（卡片装不下所有群+新建，降级为文字编号让所有群都可见）：
   ```
   bot 所在的群：
   1. {名字1} ({chat_id_1})
   2. {名字2} ({chat_id_2})
   ...
   N. {名字N} ({chat_id_N})
   N+1. 新建一个群
   请回复编号选择目标群（如 "1"）。
   ```
   等用户数字回复：
   - 选 **N+1** → **D.new**
   - 选其他编号 → record **CHAT_ID** / **CHAT_NAME** 从 items[编号-1]

### Sub-flow D.new — 创建新群

1. Determine default group name: `cc-bot: {current_dir_basename}` (e.g. project dir `D:\Projects\cc-bot-test` → `cc-bot: cc-bot-test`).
2. 用 AskUserQuestion 问默认名 vs 自定义：
   ```
   AskUserQuestion({
     questions: [{
       question: "新群命名方式？",
       header: "群名",
       multiSelect: false,
       options: [
         { label: "使用默认名「{default_name}」 (Recommended)", description: "基于当前项目目录名自动生成" },
         { label: "我要自定义群名", description: "下一步让你输入新名字" }
       ]
     }]
   })
   ```
3. 解析选择：
   - **使用默认名** → `chosen_name = default_name`，直接去 step 4
   - **我要自定义** → 告诉用户：`请回复新群名（最多 60 字）`，等文字输入，取其为 `chosen_name`（超 60 字截断）
4. Run:
   ```bash
   LARK_CLI_NO_PROXY=1 lark-cli im +chat-create --as bot \
     --name "{chosen_name}" \
     --type private \
     --users "{ADMIN_OPEN_ID}" \
     --owner "{ADMIN_OPEN_ID}" \
     --set-bot-manager \
     --format json
   ```
5. Parse `data.chat_id` from response; record as **CHAT_ID**, **CHAT_NAME = chosen_name**.
6. Tell user: `✓ 已创建新群「{CHAT_NAME}」（{CHAT_ID}），你已被加为群主，bot 自动入群。`
7. Proceed to Stage E.

**所需 scope**（若 chat-create 报权限错）：`im:chat:create` / `im:chat` / `im:chat.members:write` — 提示用户回飞书开放平台补 scope 后重发 `/cc-bot:setup`。

## Stage D-slack — 选 channel + 邀请 bot（仅 `IM_TYPE = slack`）

Slack Web API `conversations.list` 列 channel 受 2025-05-29 rate limit 改革限制（非 Marketplace 新 app: 1 req/min），LLM 拼数据交互体验也差。改为让用户**手工提供 channel_id**。

### Step 1 — 用户提供 channel_id

告诉用户：

```
请在 Slack 桌面端 / Web 端：
1. 进入你要让 cc-bot 监听的 channel（建议建个测试用的，例如 #bot-test）
2. 点 channel 名右键 → 复制频道链接，或看浏览器地址栏，URL 格式：
   https://app.slack.com/client/T<team_id>/C<channel_id>
   或：https://<workspace>.slack.com/archives/C<channel_id>
3. 把 C 开头的部分（C0xxxxxxxxxxx，9 位以上）粘过来：
```

等用户文字输入，存为 **CHAT_ID**。校验格式 `^C[A-Z0-9]{8,}$`，不符报错让重粘。

可选：再问 channel 显示名：

```
AskUserQuestion({
  questions: [{
    question: "channel 显示名（写进 active.json，仅人类阅读用，不影响功能）",
    header: "channel 名",
    multiSelect: false,
    options: [
      { label: "使用 channel_id 作为显示名 (Recommended)", description: "最简，不影响任何功能" },
      { label: "我要自定义", description: "下一步让你输入" }
    ]
  }]
})
```

选自定义 → 提示用户输入名字，存为 **CHAT_NAME**；选默认 → `CHAT_NAME = CHAT_ID`。

### Step 2 — 验证 bot 在 channel + 必要时引导邀请

试发一条 probe 消息（用 BOT_TOKEN 直接 curl，此时 active.json 还没建）：

```bash
curl -s -X POST \
  -H "Authorization: Bearer ${BOT_TOKEN}" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "{\"channel\":\"${CHAT_ID}\",\"text\":\"cc-bot setup probe — bot online\"}" \
  https://slack.com/api/chat.postMessage
```

解析返回：

- `ok=true` → bot 已在 channel，群里看到 probe 消息；继续 Stage E
- `ok=false, error=not_in_channel` → bot 未入群，告诉用户：
  ```
  bot 还没在该 channel。请在 Slack 客户端打开 #{CHAT_NAME}，输入框跑：
    /invite @cc-bot
  ```
  AskUserQuestion 等确认：
  ```
  {
    question: "在 Slack #channel 输入框跑 /invite @cc-bot 完成了吗？",
    options: [
      { label: "已邀请，继续 (Recommended)", description: "channel 看到「添加 cc-bot」消息" },
      { label: "取消 setup", description: "" }
    ]
  }
  ```
  选「已邀请」→ 重发 probe；连续 3 次仍 `not_in_channel` 则报错让用户检查 channel_id 是否输错
- 其他 error（`invalid_auth` / `channel_not_found`）→ 报错并让用户回退到对应 Step 重输

Tell user: `✓ bot 已在 #{CHAT_NAME} ({CHAT_ID})`，继续 Stage E。

## Stage E — 写配置

Steps 1-5 可以并行执行（读 template + 3 次 Write + 1 次 mkdir），提升速度。Step 6（改 `~/.claude/settings.json`）独立，放并行之后。

1. Create directories: `./.cc-bot/profiles/` and `./.cc-bot/runtime/`. Create empty `./.cc-bot/runtime/.gitkeep`.
2. Read the plugin-level template `${CLAUDE_PLUGIN_ROOT}/templates/template.json`.
3. Copy it verbatim to `./.cc-bot/profiles/template.json` (kept in project git as reference).
4. Also write a filled copy to `./.cc-bot/profiles/active.json` — fields **按 `IM_TYPE` 分流**：

   **共享字段**（两个 IM 都写）：
   - `profile_name`: current directory name (basename of `pwd`)
   - `display_name`: same
   - `im.type`: **IM_TYPE** from Stage 0 (`lark` 或 `slack`)
   - `im.chat_id`: **CHAT_ID**
   - `im.chat_name`: **CHAT_NAME**
   - `project.root`: absolute path of current directory (forward slashes, e.g. `D:/Projects/foo`)
   - `paths.bot_temp_abs`: `{project.root}/.cc-bot/bot_temp` (forward slashes, e.g. `D:/Projects/foo/.cc-bot/bot_temp`)
   - `paths.bot_temp_rel`: `./.cc-bot/bot_temp` (相对路径；集中在 `.cc-bot/` 下避免污染项目根)

   **检测 `polling_mode`**（在写 `active.json` 之前做）：
   - 检查 `process.env.ANTHROPIC_BASE_URL`（CC 主会话暴露为 env，`node -e "console.log(process.env.ANTHROPIC_BASE_URL || '')"`）
   - 若非空 **且** 不包含 `api.anthropic.com` → `POLLING_MODE = 'self-poll'`（第三方端点大概率调不动 Monitor，走 self-poll 兜底）
   - 否则 → `POLLING_MODE = 'monitor'`（官方 Claude 默认；缺省也走此档）
   - 写入 `active.json` 的 `polling_mode` 字段为 **POLLING_MODE**

   - Leave other fields (`tech_stack`, `intents`, `notes`) as-is from template — user can fill later as needed.

   **`IM_TYPE === 'lark'` 专属字段**：
   - `im.bot_app_id`: **BOT_APP_ID**（Stage B 拿到的 cli_xxx）
   - `members.admin_open_ids`: `[ADMIN_OPEN_ID]`（Stage B 拿到的 ou_xxx）
   - `im.locale`: 缺省（poll.js 自动用 `zh-CN`）

   **`IM_TYPE === 'slack'` 专属字段**：
   - `im.bot_user_id`: **BOT_USER_ID**（Stage B-slack 拿到的 U0xxx）
   - `im.extra.bot_token`: **BOT_TOKEN**（xoxb-...）
   - `im.extra.app_token`: **APP_TOKEN**（xapp-1-...）
   - `members.admin_open_ids`: `[]`（Slack setup 不强收 admin user_id；用户后续在 Slack 客户端 Profile → Copy member ID 拿到 U0xxx 后手工填 active.json）
   - `im.locale`: 缺省（poll.js 自动用 `en-US`）
   - 不写 `im.bot_app_id`（Slack 无对等字段；A0xxx App ID 不参与运行时）

   **重要**：Slack token 写入 active.json 时**必须**确保 `.gitignore` 已包含 `.cc-bot/profiles/active.json`（step 6 会处理）。setup 结束后告知用户 token 仅本地保存。
5. Write `./.cc-bot/runtime/state.json` with `last_processed_time` = current Unix ms (so the bot doesn't re-emit historical messages on first run). Example at 2026-04-21 10:30 UTC+8 → `1776684600000`:
   ```json
   {"last_processed_time":"<current-unix-ms>","pending_confirm":null,"paused":true,"monitor_task_id":null}
   ```
   Use `Date.now()` (JS) or `date +%s%3N` (bash) to get the value.
6. Append to `./.gitignore` (create if missing, skip rules that already exist):
   ```
   # cc-bot
   .cc-bot/runtime/*
   !.cc-bot/runtime/.gitkeep
   .cc-bot/bot_temp/
   .cc-bot/profiles/active.json
   ```
7. **注册 cc-bot statusline shim** — 改 `~/.claude/settings.json` 的 `statusLine.command` 指向 cc-bot 的 shim 脚本。这个 shim 每 tick 会：(a) 把 CC 注入的 stdin JSON 落盘到 `.cc-bot/runtime/hud-stdin.json` 供 bot 读取；(b) 若装了 cc-hud 则透传 stdin 并输出 cc-hud 渲染的状态栏内容（状态栏 + HUD 双得，互不冲突）。

   a. Read `~/.claude/settings.json`（用户全局；可能不存在）。若文件缺失，直接以 `{}` 为初值。

   b. Detect current statusLine state:
      - `settings.statusLine` 不存在 → `UNSET`
      - `settings.statusLine.command` 已是 cc-bot shim（含 `cc-bot` 且含 `statusline.js`）→ 比较现有命令字符串与目标字符串（即 `${CLAUDE_PLUGIN_ROOT}` 展开后的当前路径版本）：
        - 完全相等 → `ALREADY_CC_BOT_CURRENT`
        - 不相等（旧版本号、其他 plugin 根等）→ `ALREADY_CC_BOT_STALE`
      - `settings.statusLine.command` 是 cc-hud（含 `cc-hud`）→ `CC_HUD_ONLY`（shim 会自动 tee，安全覆盖）
      - 其他非空值 → `OTHER`（用户自定义 / 第三方 statusline）

   c. Based on state:
      - `UNSET` → 直接写入；告知 `✓ 首次注册 statusLine（cc-bot shim）`
      - `CC_HUD_ONLY` → 覆盖 + **明确告知用户**：`ℹ️ 检测到原 statusLine 是直接调用 cc-hud，已改为经 cc-bot shim 包装（shim 会 tee cc-hud 渲染，状态栏视觉不变，额外把 HUD 数据落盘给 bot 用）`
      - `ALREADY_CC_BOT_CURRENT` → 跳过写入，告诉用户 `✓ statusline shim 已注册（幂等跳过）`
      - `ALREADY_CC_BOT_STALE` → 覆盖（写入当前路径）+ 告知 `✓ statusline shim 路径已刷新（旧：{旧 command} → 新：{当前 command}）` — 处理升级后路径仍指旧缓存版本的场景
      - `OTHER` → 先 `AskUserQuestion` 确认：
        ```
        AskUserQuestion({
          questions: [{
            question: "检测到现有 statusLine 命令：{settings.statusLine.command}。是否用 cc-bot shim 覆盖？（cc-bot shim 会读 HUD 数据落盘，若已装 cc-hud 还会 tee 其渲染）",
            header: "statusLine",
            multiSelect: false,
            options: [
              { label: "覆盖 (Recommended)", description: "原命令将被替换；cc-bot shim 若检测到 cc-hud 会自动透传" },
              { label: "跳过", description: "保留当前 statusLine，但 bot 的 HUD 意图会常报不可用" }
            ]
          }]
        })
        ```
        用户选「跳过」则不改 settings.json，后续 HUD 意图按 SKILL §HUD 不可用处理。

   d. 写入 settings.json（合并式，不丢其他字段）：
      ```json
      {
        "statusLine": {
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/runtime/statusline.js",
          "padding": 2
        }
      }
      ```

   e. Tell user: `✓ statusline shim 已注册到 ~/.claude/settings.json（下次 CC 重启生效；或立即重新打开会话）`

8. **注册 main-busy hook**（v0.1.6+）—— 让 `~/.claude/settings.json` 的 `hooks.UserPromptSubmit` / `hooks.Stop` 调用 cc-bot 的 main-busy 脚本，实现"主窗口对话优先、群消息让路"。

   **为什么走用户全局 settings.json 而非 plugin `hooks.json`**：CC 已知 bug #10225 — plugin 声明的 UserPromptSubmit hook 完全不 fire。`main-busy.js` 自带"非 cc-bot 项目 silent skip"（检查 `.cc-bot/` 是否存在），全局注册对其他项目无副作用。
   
   a. Read `~/.claude/settings.json`（沿用 step 7 同一个文件）。缺失则以 `{}` 为初值。确保 `hooks` 是对象（`typeof hooks === 'object' && !Array.isArray(hooks)`），不是则跳过本步报警「settings.json 的 hooks 字段类型异常」（不强写覆盖）。
   
   b. 目标 hook 配置（两条都要有）：
      ```json
      {
        "hooks": {
          "UserPromptSubmit": [
            {
              "hooks": [
                { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/runtime/main-busy.js lock" }
              ]
            }
          ],
          "Stop": [
            {
              "hooks": [
                { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/runtime/main-busy.js unlock" }
              ]
            }
          ]
        }
      }
      ```
   
   c. 幂等合并：对于 `UserPromptSubmit` 和 `Stop` 两个事件各自做：
      - 若 `hooks[event]` 不存在 / 空数组 → 整段写入
      - 若已存在条目：扫描所有 `.hooks[].command`，若**已有命令**含 `main-busy.js lock`（UserPromptSubmit）或 `main-busy.js unlock`（Stop）：
        - 该命令**完全等于**目标字符串（`${CLAUDE_PLUGIN_ROOT}` 展开后） → ✓ 幂等跳过
        - 该命令含 `main-busy.js` 但不等（旧版本号、其他 plugin 根等）→ **替换该条目** 为当前目标字符串
      - 若存在非 cc-bot 的其他 hook 条目 → append 新 matcher（不删用户已有的）
   
   d. Tell user：
      - 首次注册 → `✓ 已注册 main-busy hook 到 ~/.claude/settings.json（主窗口对话期间群消息自动让路）`
      - 幂等跳过 → `✓ main-busy hook 已就位（跳过）`
      - 路径刷新（旧 main-busy 命令被替换）→ `✓ main-busy hook 路径已刷新（旧：{old} → 新：{current}）`
      - 新增但保留了其他 hook → `✓ 已追加 main-busy hook（保留你现有的其他 {event} hook）`

9. **注册 Monitor 通配权限**到 `<project>/.claude/settings.local.json`，让 cc-bot 版本升级后不再被 CC 反复询问权限。

   a. Read `<project>/.claude/settings.local.json`。文件缺失 → 初值 `{}`；解析失败 → 直接报错「settings.local.json 格式错误，请先修复」并跳过本步（不能强写覆盖用户数据）。

   b. 确保 `permissions.allow` 是数组（缺失则创建 `permissions: { allow: [] }`）。

   c. 构造通配规则（按 `process.platform` 选模板，仅注册当前平台的模板，避免 settings.local.json 里堆冗余无效规则）。v0.1.11+ 通配范围从单一 `poll.js` 扩展到整个 `runtime/*.js`，覆盖 v0.1.11 新增的 `check-image-size.js` 等工具，未来加新工具不再需要改 setup：
      - **Windows**（`win32`）：`Bash(node C:/Users/*/.claude/plugins/cache/cc-bot/cc-bot/*/runtime/*.js *)`
      - **macOS**（`darwin`）：`Bash(node /Users/*/.claude/plugins/cache/cc-bot/cc-bot/*/runtime/*.js *)`
      - **Linux**（`linux`）：`Bash(node /home/*/.claude/plugins/cache/cc-bot/cc-bot/*/runtime/*.js *)`

   d. 扫 `permissions.allow[]`：
      - 若**已有完全相同**的通配规则（`runtime/*.js *`）→ ✓ 幂等跳过
      - 若有 v0.1.3-v0.1.10 老 `runtime/poll.js --project *` 单文件通配规则 → **不自动删**（向下兼容、保留授权历史），但提示"检测到旧 poll.js 单文件通配规则，建议补一条 runtime/*.js 通配（v0.1.11+ 新增 check-image-size.js 等工具会被覆盖）"，并 append 新通配
      - 若有包含 `cache/cc-bot/cc-bot/<具体数字版本号>/runtime/poll.js` 的硬编码规则 → **不自动删**（尊重用户手工授权历史；提示"检测到 X 条硬编码版本路径，建议换为通配"即可。自动清理交给 `/cc-bot:doctor --fix` 未来实现）
      - 否则 → append 通配规则到数组末尾，Write 回去

   e. Tell user：
      - 首次注册 → `✓ 已加通配 Monitor 权限到 .claude/settings.local.json（升级 cc-bot 版本不会再弹权限询问）`
      - 幂等跳过 → `✓ Monitor 通配权限已就位（跳过）`
      - 发现硬编码僵尸 → `⚠ 检测到 N 条硬编码版本路径的旧权限规则（位置 .claude/settings.local.json）。建议手工替换为通配（按当前平台模板）。`

10. **检测 cc-hud 安装状态**（决定完成提示里附加哪段 hint）：
   ```bash
   grep -q '"cc-hud@' ~/.claude/plugins/installed_plugins.json 2>/dev/null && echo installed || echo not_installed
   ```
   设 **HUD_STATE** = `installed` 或 `not_installed`。

11. Tell user（按 IM_TYPE 拼共通部分，再根据 HUD_STATE 追加 hint）：

   **`IM_TYPE === 'lark'` 共通部分**：
   ```
   ✓ cc-bot v{version} 配置完成（IM：飞书）

   应用    {BOT_APP_ID}
   群      {CHAT_NAME}（{CHAT_ID}）
   管理员  {ADMIN_NAME}（{ADMIN_OPEN_ID}）

   可选：编辑 .cc-bot/profiles/active.json 填入 tech_stack / intents 等项目特定字段。
   ```

   **`IM_TYPE === 'slack'` 共通部分**：
   ```
   ✓ cc-bot v{version} setup complete (IM: Slack)

   Workspace  {WORKSPACE_NAME}
   Bot        {BOT_NAME} ({BOT_USER_ID})
   Channel    #{CHAT_NAME} ({CHAT_ID})

   Optional: edit .cc-bot/profiles/active.json — add your user_id to members.admin_open_ids
   (in Slack: profile → Copy member ID), and fill tech_stack / intents per project.
   ```

   **HUD_STATE == `not_installed`** 时追加：
   ```
   statusline shim 已注册，cc-bot 会自己落盘 HUD 数据。想同时让状态栏显示模型 / 上下文 / 额度？装 cc-hud（可选，shim 会自动 tee 渲染）：
     /plugin marketplace add WaterTian/cc-hud
     /plugin install cc-hud@WaterTian-cc-hud
   ```

   **HUD_STATE == `installed`** 时追加：
   ```
   ✓ cc-hud 已装 + cc-bot shim 已注册，状态栏与群里 HUD 双通路已打通。重启 CC 或重新打开会话后生效。
   ```

   最后统一追加：
   ```
   发送 /cc-bot:start 启动 bot（或在主会话说「开bot」）。
   ```

   **`POLLING_MODE === 'self-poll'`** 时再追加一行：
   ```
   ℹ️ polling_mode 已设为 self-poll — 检测到第三方 Anthropic 端点，绕开 Monitor 用 /loop 轮询。
   ```

## 幂等重入

- **Stage 0** 若 `active.json` 存在且 `im.type` 是 `lark` 或 `slack` → 跳过选 IM 用 existing value
- **Stage A (lark)** 已装 → 直接到 Stage B
- **Stage B (lark)** `auth list` 非空 → 取 BOT_APP_ID / ADMIN_OPEN_ID / ADMIN_NAME 直接到 Stage D
- **Stage B-slack** `active.json` 已存在且 `im.extra.bot_token` 非空且 auth.test 验证通过 → 跳过到 Stage D-slack
- **Stage E** 「已配置」判定按 IM 分流：
  - lark: `im.bot_app_id` 匹配 `/^cli_[a-z0-9]+$/` 且**不是** `cli_xxxxxxxxxxxx` 示例；`im.chat_id` 以 `oc_` 开头且长度 > 20
  - slack: `im.extra.bot_token` 匹配 `/^xoxb-/` 且 `im.bot_user_id` 匹配 `/^U[A-Z0-9]+$/`；`im.chat_id` 匹配 `/^C[A-Z0-9]+$/`
  - 判定为「已配置」→ 输出「已配置，可 /cc-bot:start」。**仍需复查**（共享，IM 无关）：
    - 若 `active.json` 的 `polling_mode` 字段缺失或空 → 按 Stage E step 4 的检测逻辑（读 `ANTHROPIC_BASE_URL` env）补写（幂等，可重复）
    - 若 `settings.json` 的 `statusLine.command` 未指向 cc-bot shim → 跑步骤 7 补注册（幂等，可重复）
    - 若 `settings.json` 的 `hooks.UserPromptSubmit` / `hooks.Stop` 无 cc-bot main-busy 命令 → 跑步骤 8 补注册（幂等）
    - 若 `.claude/settings.local.json` 无 Monitor 通配权限规则 → 跑步骤 9 补注册（幂等）

用户任何阶段失败后修好，再发 `/cc-bot:setup` 会自动从断点续跑。
