---
name: switch
description: Switch active cc-bot profile (usage: /cc-bot:switch <name>)
---

Switch the active cc-bot profile by overwriting `.cc-bot/profiles/active.json` with the contents of a named profile.

Usage: `/cc-bot:switch <name>`

Steps:

1. Parse `<name>` from the slash command argument. If missing, list available profiles (`.cc-bot/profiles/*.json` except `active.json` and `template.json`) and ask which one.
2. Verify `.cc-bot/profiles/<name>.json` exists. If not, tell the user available profiles or suggest `/cc-bot:new-profile <name>`.
3. Check if bot is currently running by reading `.cc-bot/runtime/state.json`. If `paused=false` and `monitor_task_id` is set:
   - Ask: "当前 bot 正在 `{current profile_name}` 上运行。切换前会先 `/cc-bot:stop` 关闭。继续吗？（Y/N）"
   - If Y: run the off flow first (TaskStop the monitor, set paused=true, send offline notification to the current chat)
   - If N: abort.
4. Copy `.cc-bot/profiles/<name>.json` contents over `.cc-bot/profiles/active.json` (full file replacement).
5. Reset `.cc-bot/runtime/state.json` to:
   ```json
   {"last_processed_time":"<current-ms>","pending_confirm":null,"paused":true,"monitor_task_id":null}
   ```
   (use current Unix ms so the bot doesn't re-emit historical messages when next turned on)
6. Clear `.cc-bot/runtime/poll.emitted` (delete the file).
7. Tell the user: "已切到 `<name>` profile。用 `/cc-bot:start` 启动 bot。"

**DO NOT automatically start the bot** — profile switches are engineering changes, user should review and explicitly turn on.
