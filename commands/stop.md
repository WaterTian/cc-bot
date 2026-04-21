---
name: stop
description: Stop cc-bot — stop Monitor, send offline notification to the IM chat
---

Execute the **cc-bot shutdown flow** defined in the `lark-bot` skill (§关闭流程).

Steps:

1. Read `.cc-bot/runtime/state.json` and get `monitor_task_id`.
2. If `monitor_task_id` is set, call `TaskStop(monitor_task_id)`. Otherwise just proceed.
3. Edit `state.json`: set `paused: true`, clear `monitor_task_id`.
4. Read `.cc-bot/runtime/hud-stdin.json` for model/context data. If the file has valid data, include 模型 + 上下文 lines in the offline notification; if missing/empty, silently skip those lines — **下线场景不触发 cc-hud shim 排查提示**（用户正在关 bot，此时刷排查提示没意义；仅 /cc-bot:start / 群里问 HUD 时才按 SKILL §HUD 不可用时的处理 输出工程提示）。
5. Send offline notification to `profile.im.chat_id`. HUD 可用时（格式 / 字段规则同 /cc-bot:start 上线通知，见 SKILL.md §开关通知）：
   ```
   cc-bot 已下线
   模型: {model_display_name}
   上下文: {bar} X% ({used} / {total})

   Bot 进入休眠，群消息将不再响应
   ```
   HUD 不可用时（最小形态，省略模型/上下文两行）：
   ```
   cc-bot 已下线

   Bot 进入休眠，群消息将不再响应
   ```
6. Verify no residual `poll.js` process matches the project:
   ```bash
   PIDS=$(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$PSItem.CommandLine -like '*runtime/poll.js*--project*<project.root>*' } | Select-Object -ExpandProperty ProcessId")
   for p in $PIDS; do taskkill //F //PID $p; done
   ```
7. Remove `.cc-bot/runtime/poll.pid` if present.

Report completion to the user in the main session.
