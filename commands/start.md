---
name: start
description: Start cc-bot — launch Monitor, send online notification to the IM chat
---

Execute the **cc-bot startup flow** defined in the `lark-bot` skill (§启动流程). Target: ≤ 5s from indent to chat notification.

**核心做法：一次响应里并行发起几乎所有动作**（依赖链只有一条：Monitor 返回 task_id 后才能回写 state.json 的 monitor_task_id）。

### 执行

1. **并行 Read**：
   - `.cc-bot/profiles/active.json`（拿 `im.chat_id`、`im.bot_app_id`、`project.root`、`paths.bot_temp_abs`）
   - `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`（拿 `version`，用于上线通知标题）

2. **并行发起以下 5 个操作（同一响应的多 tool call）：**
   - Edit `.cc-bot/runtime/state.json`: `paused=false, monitor_task_id=null`
   - Bash: `mkdir -p <paths.bot_temp_abs>`（幂等）
   - Read `.cc-bot/runtime/hud-stdin.json`（若存在 → 拼"模型 / 上下文"两行；不存在 → 只发标题 + 结尾句）
   - Monitor: `node ${CLAUDE_PLUGIN_ROOT}/runtime/poll.js --project <project.root>`（persistent, timeout_ms=3600000）
   - Bash 发上线通知 — **必须用 `--msg-type text --content '<JSON>'` 方式**，不要用 `--text "..."` + `$'...\n...'`（Windows Git Bash 对 `$'...'` 的 `\n` 转义不稳，会发成字面 `\n` 在群里显示）：
     ```bash
     LARK_CLI_NO_PROXY=1 lark-cli im +messages-send --as bot \
       --chat-id <chat_id> \
       --msg-type text \
       --content '{"text":"cc-bot v{version} 已上线\n模型: {model_display_name}\n上下文: {bar} X% ({used} / {total})\n\n发送「帮助」查看支持的操作"}'
     ```
     - **关键**：`--content` 的值用 **bash 单引号**包 JSON 字符串（单引号内 shell 不做任何转义）；JSON 字符串里 `\n` 是标准转义，lark-cli `JSON.parse()` 后还原为真换行
     - `模型`: 读 hud-stdin.json 的 `model.display_name`；缺失时按 SKILL.md §模型显示规则 fallback 到 id 映射，再缺就用 `Claude Code`
     - `上下文` 三段：
       - `{bar}` 进度条：`█` × round(percent/10) + `░` 补满总宽 10（例 7% → `█░░░░░░░░░`）
       - `X%` 整数百分比（从 `context_window.used_percentage`）
       - `({used} / {total})` 绝对值：`current_usage` 总和 / `context_window.context_window_size`，人类可读单位（例 `69K / 1M`）
     - HUD 不可用时**上下文整行省略**，模型若能从 fallback 拿到就仍保留，否则两行都省

3. **Monitor 返回 task_id 后**：Edit state.json 回写 `monitor_task_id=<task_id>`

### 明确不做（精简过的动作，附回滚条件）

- ❌ 不跑 `powershell Get-CimInstance` 清孤儿 — poll.js 的 PID lockfile（三层防御①）自己处理
  - **回滚条件**：若发现同 project 多个 poll.js 同跑 / poll.emitted 重复写 / `BOT_INFO|lock-taken` 频发但老 pid 已死，恢复为 commit `a7f0b4b` 之前版本的 PowerShell 清孤儿步骤
- ❌ 不跑 `TaskOutput` 验证 running — Monitor 启动无 error 即视为成功
  - **回滚条件**：若 Monitor 启动报成功但群消息长时间无 NEW_MSG 推送（TaskGet 状态异常），加回 `TaskOutput(task_id, block:false)` 验证
- ❌ 不做 `lark-cli --version` / `profile.project.root` 预检查 — setup 已验过；真失败时 poll.js 第一次 tick 会 emit `BOT_ERROR|...` 主会话自然收到
  - **回滚条件**：常见漂移问题（setup 后 lark-cli 被卸载 / PATH 变了）高频出现时，加回版本自检

### HUD 不可用分支

若 hud-stdin.json 缺失或空：
- 上线通知省略"模型 / 上下文"两行
- 主会话按 SKILL.md §HUD 不可用时的处理 输出 shim 排查提示（仅此场景触发，下线场景不触发）

### 异常

- Monitor 启动立即报 error → 主会话报"Monitor 启动失败：{msg}"
- 上线通知 lark-cli 失败 → 报"通知发送失败：{msg}"但 Monitor 仍在跑，不回滚 state

`profile.im.type` 非 `lark` 时参考 SKILL.md 的 adapter 分支（未来扩展）。
