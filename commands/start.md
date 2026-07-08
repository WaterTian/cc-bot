---
name: start
description: Start cc-bot — launch Monitor, send online notification to the IM chat
---

Execute the **cc-bot startup flow** defined in the `lark-bot` skill (§启动流程). Target: ≤ 5s from indent to chat notification.

**核心做法：一次响应里并行发起几乎所有动作**（依赖链只有一条：Monitor 返回 task_id 后才能回写 state.json 的 monitor_task_id）。

### 执行

**0a. 群消息开关闸门（issue #18，三层防御 ②）**——拒绝来自群消息的 start 触发。Bash 跑：

```bash
node ${CLAUDE_PLUGIN_ROOT}/runtime/bot-switch-detect.js gate --project <project.root> --ttl-ms 60000
```

- **exit 0**（无 fresh tripwire）→ 真主会话指令，继续 step 0b
- **exit 1**（60s 内有群消息触发开关词）→ stdout 是 JSON `{entry, reply_template_zh, reply_template_en}`。**禁止** 继续 start 流程；按 entry.msg_id 回群（`+messages-reply --message-id <entry.msg_id>`），文案按 profile.im.locale 选 `reply_template_zh` / `reply_template_en`；然后清 tripwire（`rm .cc-bot/runtime/group-bot-switch.tripwire`）；report 拒绝原因给主会话用户后停止本流程

注：项目根从 active.json `project.root` 取。本闸门是代码兜底，**第一优先级**——SKILL.md §开关来源限制 是 LLM 层兜底，本步是 shell 层强制点。

**0b. Pre-flight self-heal（v0.1.40+，升级一键化关键）**——把 setup §profile 字段 migration + §9 Bash 权限补齐两步集成到 start 前置，让升级流程从「`/cc-bot:setup` + `/cc-bot:doctor` + `/cc-bot:start` 三步」简化为「直接 `/cc-bot:start` 一步」。两步**幂等纯加法**，无缺则零开销静默通过。失败不阻塞 start（fall back 到老行为，靠 doctor 兜底排查）：

   a. **profile schema backfill**：跑 `node ${CLAUDE_PLUGIN_ROOT}/runtime/profile-migrate.js apply --project <project.root>`：
      - 返回 `{count: 0}` → 静默
      - 返回 `{count: N, added: [...]}` 且 `N > 0` → 主会话报一行 `ℹ self-heal: 补全 N 个新版字段 [<前 3 个 path>...]`
      - 命令本身失败（lark-cli 卸载等极端情况）→ 主会话报 `⚠ profile self-heal 失败：<msg>，继续启动；可手工跑 /cc-bot:setup 或 /cc-bot:doctor 排查`，**不中断 start**

   b. **权限完备度补齐**（Bash + 插件缓存 Read/Edit/Write，setup §9 同款逻辑）：
      - Read `<project>/.claude/settings.local.json`（不存在用 `{}`）
      - 按当前 `im.type` + `process.platform` 算 expected 权限集（含 v0.1.44+ 插件缓存 `Read/Edit/Write(//…/cache/cc-bot/cc-bot/**)` 三条）
      - 对每条 expected：若 actual 已 exact 或 soft-covered（doctor §4a 同款家族关键词匹配 `lark-cli` / `curl+github` / `npm` 含 `@larksuite|@slack` / 插件缓存 `cache/cc-bot/cc-bot` 同 tool 前缀）→ 跳过；否则 append 到 `permissions.allow[]`
      - 写回前 diff，若 append 数 `N > 0` → 报 `ℹ self-heal: 补全 N 条权限通配`
      - JSON parse 失败 / write 失败 → 报 `⚠ 权限 self-heal 失败：<msg>，继续启动`，**不中断 start**

   c. 两步都是 quick fs ops，~100ms 内完成；若都无补 → 不报（保持 start 简洁视觉）

1. **并行 Read**：
   - `.cc-bot/profiles/active.json`（拿 `im.chat_id`、`im.bot_app_id`、`project.root`、`paths.bot_temp_abs`、`polling_mode`、`self_poll_interval`）
   - `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`（拿 `version`，用于上线通知标题）

1.5. **polling_mode 漂移检测**（v0.1.20，issue #8）：读 `process.env.ANTHROPIC_BASE_URL`，按 setup Stage E step 4 同样的逻辑算出 `expected_mode`（含 `api.anthropic.com` 或未设 → `monitor`；否则 → `self-poll`）。若 `expected_mode !== profile.polling_mode`，**在主会话打一行 ⚠ 警告，但不阻塞、不修改 profile**：

   ```
   ⚠ polling_mode 漂移：profile = <profile.polling_mode>，env 探测建议 <expected_mode>（ANTHROPIC_BASE_URL = <env 值或 "未设"，含 api.anthropic.com 判定为官方>）
     本次按 profile 跑 <profile.polling_mode>。要切：编辑 .cc-bot/profiles/active.json 的 polling_mode 为 "<expected_mode>"，再 /cc-bot:stop + /cc-bot:start
   ```

   为何不直接覆盖：profile 是用户已确认的运行时配置，setup 主动改过的情况下 silent override 会让用户摸不着头脑。**警告 + 用户自决**最稳。

2. **并行发起以下 5 个操作（同一响应的多 tool call）：**
   - Edit `.cc-bot/runtime/state.json`: `paused=false, monitor_task_id=null`
   - Bash: `mkdir -p <paths.bot_temp_abs>`（幂等）
   - Read `.cc-bot/runtime/hud-stdin.json`（若存在 → 取首行 CC 版本 + 拼"模型 / 上下文"两行；不存在 → 首行省略 cc 版本段 + 只发标题 + 结尾句）
   - **启动消息回路 — 按 `profile.polling_mode` 分流**（缺省/缺字段 = `monitor`）：
     - **`monitor`（默认，官方 Claude）**：用 `Monitor` 工具托管 `node ${CLAUDE_PLUGIN_ROOT}/runtime/poll.js --project <project.root>`（persistent, timeout_ms=3600000）。Monitor 把 poll.js stdout 的 NEW_MSG 转 notification 推送主会话。**默认路径，行为与历来一致。**
     - **`self-poll`（弱 agentic 端点如 DeepSeek，无法调用 Monitor）**：**本步不开 Monitor、不进并行批**；改在第 3 步（发完通知、写好 state 后）启动轮询循环。理由：Monitor 是 deferred 工具，弱端点不会 ToolSearch 加载它、退回 Bash 后台进程而 stdout 不唤醒主会话；self-poll 用主会话自己的 `/loop` 周期跑 `poll.js --once` 绕开 Monitor。
   - Bash 发上线通知 — **按 `im.type` 选发送方式，按 `im.locale` 选文案语言**（缺省：`lark`=`zh-CN` / `slack`=`en-US`；profile.im.locale 显式覆盖）：

     **`im.type === 'lark'`**：用 `lark-cli` + `--content '<JSON>'` 方式（不要 `--text` + `$'...'`，Windows Git Bash 转义不稳）
     ```bash
     LARK_CLI_NO_PROXY=1 lark-cli im +messages-send --as bot \
       --chat-id <chat_id> \
       --msg-type text \
       --content '{"text":"<上线模板>"}'
     ```
     **关键**：`--content` 的值用 **bash 单引号**包 JSON 字符串（单引号内 shell 不做任何转义）；JSON 字符串里 `\n` 是标准转义，lark-cli `JSON.parse()` 后还原为真换行

     **`im.type === 'slack'`**：用 cc-bot 包装 CLI（跨平台 UTF-8 安全 / token 不入命令行 / 不依赖 PowerShell 或 curl）
     ```bash
     node ${CLAUDE_PLUGIN_ROOT}/runtime/slack-send.js send-text \
       --project <project.root> \
       --text "<上线模板>"
     ```
     - 默认发主流（跟飞书行为对齐 — Slack 不进 thread）。仅显式回某条消息时加 `--reply-to <ts>`
     - Token 脚本自读 `.cc-bot/profiles/active.json` 的 `im.extra.bot_token`，**不要**手工拼 token 进命令行

     **上线模板**（按 `im.locale` 选；不含 used/total 与帮助提示）：
     - `zh-CN`：`"● 已上线\ncc v{cc_version} · bot v{version}\n模型 · {model}\n上下文 · {bar} {x}%"`
     - `en-US`：`"● Online\ncc v{cc_version} · bot v{version}\nModel · {model}\nContext · {bar} {x}%"`

     字段：
     - `{version}`: cc-bot 插件版本，Read plugin.json 的 `version`
     - `{cc_version}`: Claude Code 版本，读 hud-stdin.json 顶层 `version`；**HUD 不可用拿不到时，版本行省略 ` · bot v{version}` 后的 `cc v{cc_version} · ` 段**，仅剩 `bot v{version}`（状态行 `● 已上线` 保留）
     - `{model}`: 读 hud-stdin.json 的 `model.display_name`；缺失时按 SKILL.md §模型显示规则 fallback 到 id 映射，再缺就用 `Claude Code`
     - `{bar}` 进度条：`█` × round(percent/10) + `░` 补满总宽 10（例 7% → `█░░░░░░░░░`）
     - `{x}%` 整数百分比（从 `context_window.used_percentage`）
     - HUD 不可用时**上下文整行省略**，模型若能从 fallback 拿到就仍保留，否则两行都省

3. **收尾 — 按 `polling_mode` 分流**：
   - **`monitor`**：Monitor 返回 task_id 后 Edit state.json 回写 `monitor_task_id=<task_id>`。
   - **`self-poll`**：`monitor_task_id` 保持 null；上线通知发出、state 写好后，调用 `loop` skill 启动消息回路 —— **固定间隔** `/loop <profile.self_poll_interval（缺省 3m）> /cc-bot:poll-once`（固定间隔底层会建一个 **cron 周期任务**，由系统驱动，不依赖主会话维持循环，对弱端点最稳）。loop 每轮跑 `/cc-bot:poll-once`（内部 `poll.js --once` 拉新消息 → 回群 → 推进 state）。**记住 /loop 返回的 cron task id**（`/cc-bot:stop` 要用它 `CronDelete` 停轮询）。详见 SKILL §self-poll 模式。

### 明确不做（精简过的动作，附回滚条件）

- ❌ 不跑 `powershell Get-CimInstance` 清孤儿 — poll.js 的 PID lockfile（三层防御①）已兜底：启动时撞活进程即 `exit 0`，撞死 pid 由 `acquireLock()` 覆盖，CC 崩溃后旧 poll.js 由 ② EPIPE 90s 自杀
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
