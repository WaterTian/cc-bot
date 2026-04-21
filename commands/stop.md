---
name: stop
description: Stop cc-bot — stop Monitor, send offline notification to the IM chat
---

Execute the **cc-bot shutdown flow** defined in the `lark-bot` skill (§关闭流程).

Steps:

1. Read `.cc-bot/runtime/state.json` and get `monitor_task_id`.
2. If `monitor_task_id` is set, call `TaskStop(monitor_task_id)`. Otherwise just proceed.
3. Edit `state.json`: set `paused: true`, clear `monitor_task_id`.
4. Send offline notification to `profile.im.chat_id`:
   ```
   cc-bot 已下线

   Bot 进入休眠，群消息将不再响应
   ```
5. Verify no residual `poll.js` process matches the project:
   ```bash
   PIDS=$(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$PSItem.CommandLine -like '*runtime/poll.js*--project*<project.root>*' } | Select-Object -ExpandProperty ProcessId")
   for p in $PIDS; do taskkill //F //PID $p; done
   ```
6. Remove `.cc-bot/runtime/poll.pid` if present.

Report completion to the user in the main session.
