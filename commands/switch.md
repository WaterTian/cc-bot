---
name: switch
description: Switch active cc-bot profile (usage: /cc-bot:switch <name>)
---

Switch the active cc-bot profile by overwriting `.cc-bot/profiles/active.json` with the contents of a named profile.

Usage: `/cc-bot:switch <name>`

Steps:

1. Parse `<name>` from slash command argument. If missing, list available profiles from `.cc-bot/profiles/*.json`（排除 `active.json` 和 `template.json`）and ask via **AskUserQuestion**：
   ```
   AskUserQuestion({
     questions: [{
       question: "切换到哪个 profile？",
       header: "目标 profile",
       multiSelect: false,
       options: [
         // 前 3 个 profile 各做 option：label=profile 名 / description=display_name 或 description 字段
         // 第 4 项固定："取消" / description "保持当前 profile"
       ]
     }]
   })
   ```
   profiles > 3 时列最新的 3 个 + 取消；用户想选其他 profile 可直接 `/cc-bot:switch <name>` 指定名字重跑。
2. Verify `.cc-bot/profiles/<name>.json` exists. 不存在 → tell user available profiles or suggest `/cc-bot:new-profile <name>`。
3. Check if bot currently running by reading `.cc-bot/runtime/state.json`. If `paused=false` and `monitor_task_id` is set, ask via **AskUserQuestion**：
   ```
   AskUserQuestion({
     questions: [{
       question: "当前 bot 正在 {current profile_name} 上运行，先关闭再切换吗？",
       header: "bot 运行中",
       multiSelect: false,
       options: [
         { label: "先关 bot 再切换 (Recommended)", description: "会走 /cc-bot:stop 的干净关闭流程 + 下线通知" },
         { label: "取消切换", description: "保持 bot 在当前 profile 继续跑" }
       ]
     }]
   })
   ```
   - 选「先关 bot」→ run the off flow first (TaskStop monitor, set paused=true, send offline notification to current chat)
   - 选「取消」→ abort
4. Copy `.cc-bot/profiles/<name>.json` contents over `.cc-bot/profiles/active.json` (full file replacement).
5. Reset `.cc-bot/runtime/state.json` to:
   ```json
   {"last_processed_time":"<current-ms>","pending_confirm":null,"paused":true,"monitor_task_id":null}
   ```
   (use current Unix ms so the bot doesn't re-emit historical messages when next turned on)
6. Clear `.cc-bot/runtime/poll.emitted` (delete the file).
7. Tell the user: "已切到 `<name>` profile。用 `/cc-bot:start` 启动 bot。"

**DO NOT automatically start the bot** — profile switches are engineering changes, user should review and explicitly turn on.
