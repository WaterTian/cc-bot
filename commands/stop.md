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
5. Read `.cc-bot/runtime/hud-stdin.json` for model/context data. If the file has valid data, include 模型 + 上下文 lines in the offline notification; if missing/empty, silently skip those lines — **下线场景不触发 cc-hud shim 排查提示**（用户正在关 bot，此时刷排查提示没意义；仅 /cc-bot:start / 群里问 HUD 时才按 SKILL §HUD 不可用时的处理 输出工程提示）。
6. Send offline notification to `profile.im.chat_id` — **必须用 `--msg-type text --content '<JSON>'`**（同 /cc-bot:start，避免 `$'...\n...'` 在 Windows Git Bash 下发成字面 `\n`）：
   ```bash
   LARK_CLI_NO_PROXY=1 lark-cli im +messages-send --as bot \
     --chat-id <chat_id> \
     --msg-type text \
     --content '{"text":"cc-bot v{version} 已下线\n模型: {model_display_name}\n上下文: {bar} X% ({used} / {total})\n\nBot 进入休眠，群消息将不再响应"}'
   ```
   HUD 可用时格式 / 字段规则同 /cc-bot:start 上线通知，见 SKILL.md §开关通知。HUD 不可用时（最小形态，省略模型/上下文两行）：
   ```bash
   LARK_CLI_NO_PROXY=1 lark-cli im +messages-send --as bot \
     --chat-id <chat_id> \
     --msg-type text \
     --content '{"text":"cc-bot v{version} 已下线\n\nBot 进入休眠，群消息将不再响应"}'
   ```
7. Verify no residual `poll.js` process matches the project:
   ```bash
   PIDS=$(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$PSItem.CommandLine -like '*runtime/poll.js*--project*<project.root>*' } | Select-Object -ExpandProperty ProcessId")
   for p in $PIDS; do taskkill //F //PID $p; done
   ```
8. Remove `.cc-bot/runtime/poll.pid` if present.

Report completion to the user in the main session.
