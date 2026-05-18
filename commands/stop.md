---
name: stop
description: Stop cc-bot — stop Monitor, send offline notification to the IM chat
---

Execute the **cc-bot shutdown flow** defined in the `lark-bot` skill (§关闭流程).

Steps:

1. Read `.cc-bot/runtime/state.json` and get `monitor_task_id`.
2. Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` and get `version`（用于下线通知标题）.
3. If `monitor_task_id` is set, call `TaskStop(monitor_task_id)`. Otherwise just proceed.
4. Edit `state.json`: set `paused: true`, clear `monitor_task_id`.
5. Read `.cc-bot/runtime/hud-stdin.json` for the first-line CC version + model/context data. If the file has valid data, include 模型 + 上下文 lines in the offline notification; if missing/empty, silently skip those lines — **下线场景不触发 cc-hud shim 排查提示**（用户正在关 bot，此时刷排查提示没意义；仅 /cc-bot:start / 群里问 HUD 时才按 SKILL §HUD 不可用时的处理 输出工程提示）。
6. Send offline notification to `profile.im.chat_id` — **按 `im.type` 选发送方式，按 `im.locale` 选文案语言**（缺省：`lark`=`zh-CN` / `slack`=`en-US`；profile.im.locale 显式覆盖）：

   **`im.type === 'lark'`**：
   ```bash
   LARK_CLI_NO_PROXY=1 lark-cli im +messages-send --as bot \
     --chat-id <chat_id> \
     --msg-type text \
     --content '{"text":"<下线模板>"}'
   ```

   **`im.type === 'slack'`**：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/runtime/slack-send.js send-text \
     --project <project.root> \
     --text "<下线模板>"
   ```
   默认发主流（跟飞书对齐，Slack 不进 thread）。

   **下线模板**（按 `im.locale` 选）：

   HUD 可用（完整形态）：
   - `zh-CN`：`"bot v{version} cc v{cc_version} 已下线\n模型: {model}\n上下文: {bar} {x}% ({used} / {total})\n\nBot 进入休眠，群消息将不再响应"`
   - `en-US`：`"bot v{version} cc v{cc_version} is offline\nModel: {model}\nContext: {bar} {x}% ({used} / {total})\n\nBot is going to sleep — group messages won't be handled"`

   HUD 不可用（最小形态，省略模型/上下文两行 + 首行省略 ` cc v{cc_version}` 段）：
   - `zh-CN`：`"bot v{version} 已下线\n\nBot 进入休眠，群消息将不再响应"`
   - `en-US`：`"bot v{version} is offline\n\nBot is going to sleep — group messages won't be handled"`

   字段规则同 /cc-bot:start 上线通知，见 SKILL.md §开关通知。
7. Verify no residual `poll.js` process matches the project — **按平台选命令**：

   **Windows**（Git Bash）：
   ```bash
   PIDS=$(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$PSItem.CommandLine -like '*runtime/poll.js*--project*<project.root>*' } | Select-Object -ExpandProperty ProcessId")
   for p in $PIDS; do taskkill //F //PID $p; done
   ```

   **macOS / Linux**（bash / zsh）：
   ```bash
   pgrep -f "runtime/poll\.js .*--project .*<project.root>" | xargs -r kill -TERM
   # 若 2 秒后仍存活，强制 kill -9
   sleep 2 && pgrep -f "runtime/poll\.js .*--project .*<project.root>" | xargs -r kill -9
   ```

   平台判定：CC 主会话先查 `process.platform`（`win32` → Windows 分支；`darwin`/`linux` → Unix 分支）。
8. Remove `.cc-bot/runtime/poll.pid` if present.

Report completion to the user in the main session.
