---
name: start
description: Start cc-bot — launch Monitor, send online notification to the IM chat
---

Execute the **cc-bot startup flow** defined in the `lark-bot` skill (§启动流程).

Summary of what to do (the skill has full detail):

1. Read `.cc-bot/profiles/active.json` and validate required fields (`im.type` / `im.bot_app_id` / `im.chat_id` / `project.root`).
2. Run the self-check (project.root exists; bot_temp dir; lark-cli installed; optional MCP warnings).
3. Set `.cc-bot/runtime/state.json` → `paused: false`, `monitor_task_id: null` (will be written after Monitor starts).
4. Clear any orphan `poll.js` processes + stale `poll.pid` (per project.root match; do NOT kill across projects).
5. Start Monitor:
   ```
   Monitor(
     command: "node ${CLAUDE_PLUGIN_ROOT}/runtime/poll.js --project <project.root>",
     description: "cc-bot 群消息 API 轮询（30s 兜底）",
     persistent: true,
     timeout_ms: 3600000
   )
   ```
6. Record the Monitor `task_id` into `state.json` as `monitor_task_id`.
7. Verify: `TaskOutput(task_id, block:false)` status is `running`; no `BOT_ERROR|` in stdout.
8. Read `.cc-bot/runtime/hud-stdin.json` for model/context data. If the file is missing or empty, skip the `模型` / `上下文` lines in the notification AND emit the cc-hud install hint to the main session (see SKILL.md §HUD 不可用时的处理).
9. Send online notification to `profile.im.chat_id`:
   ```
   cc-bot 已上线
   模型: {model name from HUD, or just "Claude Code"}
   {optional: 上下文: ██░░░░░░░░ 13% (130K / 1M)}

   发送「帮助」查看支持的操作
   ```

If any step fails, report to the user in the main session (engineering log — do NOT send failure to the chat).

Refer to the `lark-bot` skill for the full startup specification, especially if `profile.im.type` is not `lark`.
