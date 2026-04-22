---
name: setup
description: End-to-end cc-bot bootstrap — install/verify lark-cli, guide app creation, auto-detect bot_app_id/chat_id/admin_open_id, write active.json
---

Bootstrap cc-bot for the **current project** (the directory where the user runs Claude Code). This command is **idempotent** — each stage checks state and skips when already done.

Run all bash commands with `LARK_CLI_NO_PROXY=1` prefix to avoid vpn/proxy issues with lark-cli.

---

## Stage 0 — 确定 IM 工具

Current cc-bot only ships a single IM adapter (飞书 / lark). **Silently set `IM_TYPE = lark` and proceed directly to Stage A** — do NOT print a prompt, do NOT call `AskUserQuestion`.

IM 信息会在最后 Stage E 的完成提示里告知用户（`IM：飞书`），无需提前询问。

**未来扩展点**：当 cc-bot 加入第二个 adapter（wecom / dingtalk / slack 等）时，本阶段改为 `AskUserQuestion` 选择列表，默认高亮第一个 Recommended 项。判断条件：adapter 数 == 1 则静默，≥ 2 则交互。

## Stage A — lark-cli 安装

1. Run `lark-cli --version`.
2. If the command fails / not found:
   - Tell the user: `未检测到 lark-cli，自动安装（npm i -g @larksuite/cli）...`
   - Run `npm i -g @larksuite/cli`. If it fails, report the error and stop; ask user to fix npm/node and re-run `/cc-bot:setup`.
   - Re-run `lark-cli --version` to confirm.
3. Tell the user: `✓ lark-cli {version} 已安装`

## Stage B — 应用准备 + lark-cli 登录

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

## Stage D — 选群 + 拿 chat_id

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

## Stage E — 写配置

Steps 1-6 可以并行执行（读 template + 4 次 Write + 1 次 mkdir），提升速度。Step 7（改 `~/.claude/settings.json`）独立，放并行之后。

1. Create directories: `./.cc-bot/profiles/` and `./.cc-bot/runtime/`. Create empty `./.cc-bot/runtime/.gitkeep`.
2. Read the plugin-level template `${CLAUDE_PLUGIN_ROOT}/templates/template.json`.
3. Copy it verbatim to `./.cc-bot/profiles/template.json` (kept in project git as reference).
4. Also write a filled copy to `./.cc-bot/profiles/active.json` — set these fields from the detected values:
   - `profile_name`: current directory name (basename of `pwd`)
   - `display_name`: same
   - `im.type`: **IM_TYPE** from Stage 0 (currently always `lark`)
   - `im.bot_app_id`: **BOT_APP_ID**
   - `im.chat_id`: **CHAT_ID**
   - `im.chat_name`: **CHAT_NAME**
   - `project.root`: absolute path of current directory (forward slashes, e.g. `D:/Projects/foo`)
   - `paths.bot_temp_abs`: `{project.root}/.cc-bot/bot_temp` (forward slashes, e.g. `D:/Projects/foo/.cc-bot/bot_temp`)
   - `paths.bot_temp_rel`: `./.cc-bot/bot_temp` (相对路径；集中在 `.cc-bot/` 下避免污染项目根)
   - `members.admin_open_ids`: `[ADMIN_OPEN_ID]`
   - Leave other fields (`tech_stack`, `intents`, `notes`) as-is from template — user can fill later as needed.
5. Write `./.cc-bot/runtime/state.json` with `last_processed_time` = current Unix ms (so the bot doesn't re-emit historical messages on first run). Example at 2026-04-21 10:30 UTC+8 → `1776684600000`:
   ```json
   {"last_processed_time":"<current-unix-ms>","pending_confirm":null,"paused":true,"monitor_task_id":null}
   ```
   Use `Date.now()` (JS) or `date +%s%3N` (bash) to get the value.
6. **Pre-fill `./.cc-bot/runtime/member-cache.json`** with the admin entry from Stage B. This saves the bot one `lark-cli contact +get-user` call on the first group message:
   ```json
   {
     "<ADMIN_OPEN_ID>": { "name": "<ADMIN_NAME>", "role": "admin" }
   }
   ```
7. Append to `./.gitignore` (create if missing, skip rules that already exist):
   ```
   # cc-bot
   .cc-bot/runtime/*
   !.cc-bot/runtime/.gitkeep
   .cc-bot/bot_temp/
   .cc-bot/profiles/active.json
   ```
8. **注册 cc-bot statusline shim** — 改 `~/.claude/settings.json` 的 `statusLine.command` 指向 cc-bot 的 shim 脚本。这个 shim 每 tick 会：(a) 把 CC 注入的 stdin JSON 落盘到 `.cc-bot/runtime/hud-stdin.json` 供 bot 读取；(b) 若装了 cc-hud 则透传 stdin 并输出 cc-hud 渲染的状态栏内容（状态栏 + HUD 双得，互不冲突）。

   a. Read `~/.claude/settings.json`（用户全局；可能不存在）。若文件缺失，直接以 `{}` 为初值。

   b. Detect current statusLine state:
      - `settings.statusLine` 不存在 → `UNSET`
      - `settings.statusLine.command` 已是 cc-bot shim（含 `cc-bot` 且含 `statusline.js`）→ `ALREADY_CC_BOT`
      - `settings.statusLine.command` 是 cc-hud（含 `cc-hud`）→ `CC_HUD_ONLY`（shim 会自动 tee，安全覆盖）
      - 其他非空值 → `OTHER`（用户自定义 / 第三方 statusline）

   c. Based on state:
      - `UNSET` → 直接写入；告知 `✓ 首次注册 statusLine（cc-bot shim）`
      - `CC_HUD_ONLY` → 覆盖 + **明确告知用户**：`ℹ️ 检测到原 statusLine 是直接调用 cc-hud，已改为经 cc-bot shim 包装（shim 会 tee cc-hud 渲染，状态栏视觉不变，额外把 HUD 数据落盘给 bot 用）`
      - `ALREADY_CC_BOT` → 跳过写入，告诉用户 `✓ statusline shim 已注册（幂等跳过）`
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

9. **注册 Monitor 通配权限**到 `<project>/.claude/settings.local.json`，让 cc-bot 版本升级后不再被 CC 反复询问权限。

   a. Read `<project>/.claude/settings.local.json`。文件缺失 → 初值 `{}`；解析失败 → 直接报错「settings.local.json 格式错误，请先修复」并跳过本步（不能强写覆盖用户数据）。

   b. 确保 `permissions.allow` 是数组（缺失则创建 `permissions: { allow: [] }`）。

   c. 构造通配规则（按平台；Windows 为主，同时加 Unix 模板兼顾未来跨平台）：
      - Windows：`Bash(node C:/Users/*/.claude/plugins/cache/cc-bot/cc-bot/*/runtime/poll.js --project *)`
      - 当前只写 Windows 模板即可（cc-bot 主要用户在 Windows；Mac/Linux 适配后再补）

   d. 扫 `permissions.allow[]`：
      - 若**已有完全相同**的通配规则 → ✓ 幂等跳过
      - 若有包含 `cache/cc-bot/cc-bot/<具体数字版本号>/runtime/poll.js` 的硬编码规则 → **不自动删**（尊重用户手工授权历史；提示"检测到 X 条硬编码版本路径，建议换为通配"即可。自动清理交给 `/cc-bot:doctor --fix` 未来实现）
      - 否则 → append 通配规则到数组末尾，Write 回去

   e. Tell user：
      - 首次注册 → `✓ 已加通配 Monitor 权限到 .claude/settings.local.json（升级 cc-bot 版本不会再弹权限询问）`
      - 幂等跳过 → `✓ Monitor 通配权限已就位（跳过）`
      - 发现硬编码僵尸 → `⚠ 检测到 N 条硬编码版本路径的旧权限规则（位置 .claude/settings.local.json）。建议手工替换为通配：\nBash(node C:/Users/*/.claude/plugins/cache/cc-bot/cc-bot/*/runtime/poll.js --project *)`

10. **检测 cc-hud 安装状态**（决定完成提示里附加哪段 hint）：
   ```bash
   grep -q '"cc-hud@' ~/.claude/plugins/installed_plugins.json 2>/dev/null && echo installed || echo not_installed
   ```
   设 **HUD_STATE** = `installed` 或 `not_installed`。

11. Tell user（根据 HUD_STATE 拼出对应 hint）：

   共通部分：
   ```
   ✓ cc-bot 配置完成（IM：飞书）

   应用    {BOT_APP_ID}
   群      {CHAT_NAME}（{CHAT_ID}）
   管理员  {ADMIN_NAME}（{ADMIN_OPEN_ID}）

   可选：编辑 .cc-bot/profiles/active.json 填入 tech_stack / intents 等项目特定字段。
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

## 幂等重入

- **Stage A** 已装 → 直接到 B
- **Stage B** `auth list` 非空 → 取出 BOT_APP_ID / ADMIN_OPEN_ID / ADMIN_NAME 直接到 Stage D
- **Stage E** `active.json` 存在且字段非占位符（`im.bot_app_id` 匹配 `/^cli_[a-z0-9]+$/` 且**不是** `cli_xxxxxxxxxxxx` 示例；`im.chat_id` 以 `oc_` 开头且长度 > 20）→ 输出「已配置，可 /cc-bot:start」。**仍需复查**：
  - 若 `settings.json` 的 `statusLine.command` 未指向 cc-bot shim → 跑步骤 8 补注册（幂等，可重复）
  - 若 `.cc-bot/runtime/member-cache.json` 缺失 → 跑步骤 6 补写入
  - 若 `.claude/settings.local.json` 无 Monitor 通配权限规则 → 跑步骤 9 补注册（幂等）

用户任何阶段失败后修好，再发 `/cc-bot:setup` 会自动从断点续跑。
