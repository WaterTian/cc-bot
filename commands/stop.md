---
name: stop
description: Stop cc-bot — stop Monitor, send offline notification to the IM chat
---

Execute the **cc-bot shutdown flow** defined in the `lark-bot` skill (§关闭流程).

Steps:

0. **群消息开关闸门**（issue #18，三层防御 ②）—— 拒绝来自群消息的 stop 触发。Bash 跑：

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/runtime/bot-switch-detect.js gate --project <project.root> --ttl-ms 60000
   ```

   - **exit 0**（无 fresh tripwire）→ 真主会话指令，继续 step 1
   - **exit 1**（60s 内有群消息触发开关词）→ stdout 是 JSON `{entry, reply_template_zh, reply_template_en}`。**禁止** 继续 stop 流程；按 entry.msg_id 回群（用 `+messages-reply --message-id <entry.msg_id>` 而非主流），文案按 profile.im.locale 选 `reply_template_zh` / `reply_template_en`；然后 `node ${CLAUDE_PLUGIN_ROOT}/runtime/bot-switch-detect.js` 清 tripwire（或 `rm .cc-bot/runtime/group-bot-switch.tripwire`）；report 拒绝原因给主会话用户后停止本流程

   注：项目根从 active.json `project.root` 取。本闸门是代码兜底，**第一优先级**——SKILL.md §开关来源限制 是 LLM 层兜底，本步是 shell 层强制点。

1. Read `.cc-bot/runtime/state.json`（get `monitor_task_id`）and `.cc-bot/profiles/active.json`（get `polling_mode`，缺省/缺字段 = `monitor`）.
2. **`monitor` 模式**：If `monitor_task_id` is set, call `TaskStop(monitor_task_id)`. Otherwise just proceed.
   **`self-poll` 模式**：`monitor_task_id` 本就是 null（无 Monitor），跳过 TaskStop。self-poll 用 `/loop` 起了一个 **cron 周期任务**（每 interval 跑 /cc-bot:poll-once）—— **必须 `CronDelete` 掉它才能真正停轮询**：cron task id 在 start 那轮 /loop 的输出里（同会话直接拿）；跨会话 / 拿不到则 `CronList` 找命令含 `/cc-bot:poll-once` 的 cron 再删。删 cron 后再设 `paused=true`（下一步）作双保险 —— 即使 cron 漏删，`poll.js --once` 读到 paused 也不处理消息。
3. Edit `state.json`: set `paused: true`, clear `monitor_task_id`.
4. Read `.cc-bot/runtime/hud-stdin.json` for context (上下文) data. If valid, include the 上下文 line in the offline notification; if missing/empty, silently skip it — **下线场景不触发 cc-hud shim 排查提示**（用户正在关 bot，此时刷排查提示没意义；仅 /cc-bot:start / 群里问 HUD 时才按 SKILL §HUD 不可用时的处理 输出工程提示）。
5. Send offline notification to `profile.im.chat_id` — **按 `im.type` 选发送方式，按 `im.locale` 选文案语言**（缺省：`lark`=`zh-CN` / `slack`=`en-US`；profile.im.locale 显式覆盖）：

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

   **下线模板**（按 `im.locale` 选）—— 不含版本/模型/休眠提示行：

   HUD 可用（含上下文行）：
   - `zh-CN`：`"○ 已下线\n上下文 · {bar} {x}%"`
   - `en-US`：`"○ Offline\nContext · {bar} {x}%"`

   HUD 不可用（拿不到上下文，省略上下文行）：
   - `zh-CN`：`"○ 已下线"`
   - `en-US`：`"○ Offline"`

   `{bar}` / `{x}` 字段来源见 SKILL.md §开关通知。
6. Verify no residual `poll.js` process matches the project — **按平台选命令**：

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
7. Remove `.cc-bot/runtime/poll.pid` if present.

Report completion to the user in the main session.
