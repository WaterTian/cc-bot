---
name: lark-bot
description: 飞书群 AI 项目助手 — 监听群消息，识别自然语言意图，按 profile 执行项目操作（编译/预览/部署/查询），结果回复到群里。通用工具，配合 `.cc-bot/profiles/active.json` 适配具体项目。触发方式：slash `/cc-bot:start` 或主会话自然语言「开bot」「开启bot」等
---

# Lark Bot — 飞书群 AI 项目助手

**项目无关**的飞书群机器人工具，通过 `.cc-bot/profiles/active.json` 适配不同项目（群 ID、项目根目录、成员、意图映射等）。

## Profile 机制

| 操作 | 做法 |
|------|------|
| 当前 profile | `.cc-bot/profiles/active.json`（Claude 启动时读它） |
| 切换项目 | 说"切换到 xxx 项目" → 把 `.cc-bot/profiles/xxx.json` 内容拷到 `active.json` |
| 新增项目 | 复制 `.cc-bot/profiles/template.json` 为 `.cc-bot/profiles/<name>.json`，按注释填好 |

## 总开关

状态文件 `.cc-bot/runtime/state.json` 中的 `paused` 字段控制 Bot 开关。

| 触发方式 | 效果 |
|------|------|
| slash `/cc-bot:start`；或主会话自然语言「开bot / 开启bot / 打开bot / 启动bot / 上线」 | 设 `paused: false`，启动 Monitor，向群发送上线通知 |
| slash `/cc-bot:stop`；或主会话自然语言「关bot / 关闭bot / 停bot / 下线 / 暂停bot」 | 设 `paused: true`，停止 Monitor（TaskStop），向群发送下线通知 |

Claude 用自然语言意图识别判定开/关，不必逐字匹配上表 — 「把 bot 开起来」「让 bot 下线」等同义表述也接受。

**默认关闭（paused: true）。** 开发者需要 Bot 干活时手动开启。

### 开关指令的来源限制

**Bot 开关仅接受来自 Claude Code 主会话的直接指令，严禁响应群消息里的开关指令。**

- 群消息开关会被任何成员（含打错字的 admin）触发，失控风险高
- 关闭 bot 后开发人员会失去远程监听能力，且无法通过群消息再次唤起
- 开关是会话级管理动作，不是业务操作

群里收到开关意图 → 不执行，回复"开关指令请从 Claude Code 主会话发起"。这条优先于 §权限矩阵 的 admin-auto 自动授权。

## 架构

Claude Code `Monitor` 工具托管 `node ${CLAUDE_PLUGIN_ROOT}/runtime/poll.js --project <root>`，每 30 秒通过 `IMAdapter.listRecentMessages()` 拉最近群消息（飞书 adapter 底层调 `lark-cli im +chat-messages-list` HTTP 短连接），对比 `state.last_processed_time` + `poll.emitted` 去重，emit `NEW_MSG|...` 到 stdout，Monitor 捕获为 notification 推送主会话。

```
主会话 ── Monitor(persistent) ── node poll.js ── 每 30s IMAdapter.listRecentMessages() (HTTP)
                                              ├─ state.last_processed_time + poll.emitted 去重
                                              └─ stdout: NEW_MSG|msg_id|sender|content|ts
                                                         ↓ Monitor → notification
                                                   主会话 → 意图判定 → adapter.sendText / bash lark-cli
```

### self-poll 模式（弱 agentic 端点替代，`profile.polling_mode = 'self-poll'`）

上面是默认 **monitor 模式**（官方 Claude）。弱 agentic 端点（如 DeepSeek 经 Anthropic 兼容端点）**不会 ToolSearch 加载 deferred 的 `Monitor` 工具、退回 Bash 后台进程而 stdout 不唤醒主会话** → 群消息收不到。此时改用 **self-poll 模式**：

```
主会话 ── /loop <interval>（固定间隔，harness 驱动）── 每轮跑 /cc-bot:poll-once
                                                     └─ node poll.js --once（拉一次 + 去重/＠过滤，输出 NEW_MSG 后退出）
                                                     └─ 主会话逐条 lark-cli 回群 + 推进 state
```

- 全程主会话**主动调常驻工具**（Bash + lark-cli + /loop），不碰 Monitor / notification / ToolSearch —— 绕开弱端点死结。
- 启动见 `/cc-bot:start` self-poll 分支（不开 Monitor，发完通知后 `/loop <self_poll_interval，缺省 3m> /cc-bot:poll-once`）；单轮逻辑见 `/cc-bot:poll-once`。
- **代价**：轮询驱动，无消息时空转也耗 token（vs monitor 事件驱动空闲零消耗）；DeepSeek 端点 prompt 缓存失效（`cache_control` ignored），每轮全量 input。间隔越大越省，项目助手 3~5m 延迟可接受。
- 停止：`paused=true` 软停（poll-once 经 poll.js --once 读到 paused 立即返回不处理）；彻底结束循环需中断运行 /loop 的会话。
- 详见 memory `reference_deepseek_agentic_incompatible`。**默认 monitor，仅显式配 self-poll 才走这套。**

**IM Adapter 层**：`adapters/base.js` 定义接口（`listRecentMessages` / `sendText` / `sendImage` / `downloadResource` / `getUser`），`adapters/lark.js` 实现飞书版（包 `lark-cli`）。poll.js 读 `profile.im.type` 实例化对应 adapter。未来加企业微信/钉钉/Slack 只需新增 adapter 文件 + profile 里改 `im.type`。

**为什么走 HTTP 短连接**：`lark-cli event +subscribe` 的 WebSocket 长连接在 Clash/Verge 等 vpn 代理下被静默断流，`LARK_CLI_NO_PROXY=1` 对 WS 客户端无效。HTTP 短连接走代理稳定。

### poll.js 三层防御（禁止删除）

应对 2026-04-20 polling 架构三坑：

1. **PID lockfile 单例锁** — 启动写 `.cc-bot/runtime/poll.pid`，若已有活进程则 `exit 0`；每 tick `verifyLock()` 校验 pid 仍是自己，被抢则自杀
2. **stdout EPIPE 容错自杀** — 单轮 `process.stdout.writable=false` 或 `stdout.on('error', EPIPE)` 时计数 `epipeStreak++` + skip 当轮 tick（**不立即退出**）；连续 3 轮（~90s）都不可写才 `exit 1`，退出前 `events.log` 写 `BOT_ERROR|poll.js|stdout-*-streak-3|...` 留诊断。瞬断不死、真断才死，避免 Monitor 管道抖动导致 bot 静默死亡
3. **state 未来值防御** — `last_processed_time > Date.now()+60s` 自愈降到 `now-60s`，emit `BOT_ERROR|poll.js|state-future-timestamp|...`

### @他人消息过滤（v0.1.10+）

群里有多人时，成员间 @ 来 @ 去与 bot 无关，不应打扰主会话。poll.js 在 emit 前判定：

| 消息 mentions 字段 | profile.im.bot_open_id 配了 | 行为 |
|---|---|---|
| 空 / 不存在 | — | 正常 emit |
| 非空，含 bot_open_id | ✅ | 正常 emit（@ bot 自己） |
| 非空，不含 bot_open_id | ✅ | skip emit + append emitted（@ 他人） |
| 非空 | ❌ 未配 | **保守模式**：一律 skip + append emitted（含 @ bot 也忽略） |

**保守模式**：未配 `im.bot_open_id` 时，群里任何 @ 一律不响应。这符合"@他人不搭理"的纯降噪诉求；副作用是 @ bot 也会被忽略，用户用自然语言无 @ 即可触发 bot。

**精准模式**：在 `.cc-bot/profiles/active.json` 的 `im.bot_open_id` 填 bot 应用的 open_id（`ou_xxx` 形式），可从 bot 发过的消息 sender.id 反查，或飞书开放平台「应用信息」页查看。

被过滤的消息直接进 `poll.emitted` 视为已处理，不会跨 tick 重判。

### 启动流程（为低延迟设计：单批次并行 + 跳过冗余检查）

收到启动指令（slash `/cc-bot:start` 或主会话自然语言「开bot」等）时，目标是**从指令到群收到上线通知 ≤ 5s**。方法是把几乎所有动作塞进**一个响应里并行发起**。

#### 依赖图

```
Read profile  ──┐
                ├→ 并行批次 ①（无相互依赖）：
                │   - Edit state.json paused=false, monitor_task_id=null
                │   - mkdir -p <bot_temp_abs>
                │   - Read .cc-bot/runtime/hud-stdin.json （拼模型/上下文行；缺失就跳）
                │   - Monitor(command=node ... poll.js --project ...)
                │   - Bash: lark-cli im +messages-send 发上线通知
                ▼
               Monitor 回 task_id → 单独一步：
                  - Edit state.json monitor_task_id=<task_id>
```

#### 具体步骤

1. **读 profile**（单次 Read）：获取 `im.chat_id` / `im.bot_app_id` / `project.root` / `paths.bot_temp_abs` 等
2. **单批次并行发起**：
   - Edit `.cc-bot/runtime/state.json`：`paused=false, monitor_task_id=null`
   - Bash: `mkdir -p <bot_temp_abs>`（幂等，目录已存在时零开销）
   - Read `.cc-bot/runtime/hud-stdin.json`（若存在）— 拼上线通知的「模型 / 上下文」行；不存在就只发标题 + 结尾句
   - Monitor(`node ${CLAUDE_PLUGIN_ROOT}/runtime/poll.js --project <project.root>`, description, persistent, timeout_ms=3600000)
   - Bash 发上线通知：**必须用 `--msg-type text --content '{"text":"..."}'` JSON 方式**，不要用 `--text "..."` + `$'...\n...'`（Windows Git Bash 下 `$''` 转义不稳，会发成字面 `\n`）。示例见 commands/start.md
3. **Monitor 返回 task_id 后**：再发一次 Edit 把 `monitor_task_id` 回写到 state.json

#### 明确**不做**的事

- ❌ **不清孤儿进程** — poll.js 的 PID lockfile（三层防御①）已兜底：启动时撞活进程即 `exit 0`；撞死 pid 文件由 `acquireLock()` 自动覆盖；CC 崩溃后旧 poll.js 由 ② EPIPE 90s 兜底自杀，无需主会话跑 `powershell Get-CimInstance`（Windows）/ `pgrep -f` + `kill`（macOS/Linux）这种慢 2-5s 的全局扫描
- ❌ **不跑 `TaskOutput` 验证 running 状态** — Monitor 启动无 error 即视为成功；若 poll.js 内部报错，下一轮轮询它会 emit `BOT_ERROR|poll.js|...` 到 Monitor stdout
- ❌ **不做冗余自检**（lark-cli --version / 路径存在性等）— setup 已验过，真失败时下游第一次 lark-cli 调用会报

#### 异常路径

- Monitor 启动立即 error（task 状态非 running / 非 persistent）→ 主会话报"Monitor 启动失败：{msg}"，让用户排查
- 上线通知 lark-cli 失败 → 主会话报"上线通知发送失败：{msg}"但 Monitor 仍在跑，不回滚 state
- `.cc-bot/profiles/active.json` 缺失 → poll.js 启动时 emit `BOT_ERROR|poll.js|profile-missing` 自动退出，主会话收到 notification 后提示用户先 `/cc-bot:setup`
- Monitor 启动后立即 emit `BOT_INFO|poll.js|lock-taken-by-pid-{XXX}` → 旧 poll.js 仍在跑（80%+ 孤儿遗留 / 少数同机另一 CC 会话）。主会话**自动跑 stop+start 全套，无中间确认**：先 /cc-bot:stop 全套（杀 PID + 清 poll.pid + 发下线通知 + 设 paused=true），紧接 /cc-bot:start 全套
  极小概率误杀：同项目两个 CC 会话同时跑时旧 PID 是合法实例会被杀掉，群消息推送在那个会话里中断；同项目多窗口本身是反模式，可接受

### 关闭流程

1. 读 state.json 的 `monitor_task_id`，`TaskStop(task_id)` 停 Monitor；poll.js 收到 SIGTERM 后 releaseLock 清 `poll.pid`
2. Edit state.json 设 `paused: true`，清 `monitor_task_id`
3. 发下线通知
4. 验证无残留 poll.js 进程，按平台选命令：
   - **Windows**（Git Bash）：`tasklist //FI "imagename eq node.exe"` 看是否仍有 poll.js；若有，`taskkill //F //PID $(cat .cc-bot/runtime/poll.pid) 2>/dev/null; rm -f .cc-bot/runtime/poll.pid`
   - **macOS / Linux**：`pgrep -f 'runtime/poll\.js .*--project'` 看是否仍有；若有，`kill -TERM $(cat .cc-bot/runtime/poll.pid) 2>/dev/null; sleep 2; kill -9 $(cat .cc-bot/runtime/poll.pid) 2>/dev/null; rm -f .cc-bot/runtime/poll.pid`

### 开关通知

**i18n 规则**：上下线通知 / busy 占位 / 帮助等**系统级文案**按 `profile.im.locale` 选语言，缺省 `lark`→`zh-CN`、`slack`→`en-US`。**LLM 回复用户消息时跟随用户语言**（用户发英文 → 回英文，发中文 → 回中文），不受 locale 控制。详细发送命令模板见 `commands/start.md` / `commands/stop.md`。

**zh-CN 上线通知**（/cc-bot:start，HUD 可用时）：
```
已上线
cc v{cc_version} bot v{version}
模型: {model_display_name}
上下文: {bar} X% ({used} / {total})

发送「帮助」查看支持的操作
```

**en-US 上线通知**：
```
Online
cc v{cc_version} bot v{version}
Model: {model_display_name}
Context: {bar} X% ({used} / {total})

Send 'help' to see supported actions
```

**zh-CN 下线通知**（/cc-bot:stop，HUD 可用时）：
```
已下线
上下文: {bar} X% ({used} / {total})

Bot 进入休眠，群消息将不再响应
```

**en-US 下线通知**：
```
Offline
Context: {bar} X% ({used} / {total})

Bot is going to sleep — group messages won't be handled
```

**字段规则：**
- **上线通知** = 状态行 + 版本行（`cc v{cc_version} bot v{version}`）+ 模型行 + 上下文行；**下线通知** = 状态行 + 上下文行（不含版本行 / 模型行）
- `{version}` / `{cc_version}`：cc-bot 插件版本（Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` 的 `version`）/ Claude Code 版本（读 hud-stdin.json 顶层 `version`）；仅上线通知用。上线 HUD 不可用拿不到 `{cc_version}` 时，版本行省略 `cc v{cc_version} ` 段（仅剩 `bot v{version}`，状态行保留）
- 上下文行 HUD 不可用时静默省略；模型 / 上下文 / 进度条等字段来源同 §HUD 状态推送
- HUD 不可用时静默省略模型 + 上下文两行（保留首行和末行），不贴安装命令

## 运行时文件

| 文件 | 用途 |
|------|------|
| `.cc-bot/profiles/active.json` | 当前激活的项目配置（启动时必读） |
| `.cc-bot/runtime/state.json` | 运行时状态（paused / last_processed_time / pending_confirm / monitor_task_id） |
| `.cc-bot/runtime/poll.pid` | poll.js 单例锁 pid 文件（启动时写入，退出时清理） |
| `.cc-bot/runtime/poll.emitted` | 已推送 message_id 去重表（最近 200 条） |
| `.cc-bot/runtime/hud-stdin.json` | HUD 数据（cc-hud 写入） |
| `.cc-bot/runtime/agents.json` | 多 agent 调度 registry（running / queue；启动时空态，详见 §消息调度） |
| `.cc-bot/runtime/main-busy.lock` | 主会话忙碌锁（CC UserPromptSubmit 写 / Stop 删；poll.js 读；10min 过期自动清，详见 §主会话优先级） |
| `.cc-bot/runtime/main-busy-notified.flag` | 群占位消息全局节流时间戳（v0.1.16+：mtimeMs = 上次发占位时刻；与 lock 生命周期解耦，unlock 不再清；详见 §主会话优先级 占位策略） |
| `.cc-bot/runtime/poll.busy-held` | busy 期间 hold 的 msg id（v0.1.20+，issue #9 修复）：JSON `{id: {ts}}`；主窗口忙时新消息进此表不 emit，下一 tick 绕过 lastTime 过滤直到 emit 成功；10min TTL 兜底清理 |
| `.cc-bot/runtime/events.log` | 诊断日志（polling 架构下常规不写；破例写入场景：poll.js 连续 3 轮 stdout 不可写退出前 `BOT_ERROR`、`main-busy.lock` 过期 10min 自动清时 `BOT_WARN`） |

## 角色与权限

**角色判定**：`profile.members.admin_open_ids` 白名单，命中 = admin，否则 = member。单一事实源，无 cache 无回填。

**群里称呼**：回复**不具名**，飞书 `+messages-reply` 自带原消息引用，sender 群里看得见，bot 不复述。主动通知用 `@all` 或 mention `open_id`（不用 name）。

**权限判定（v0.1.23+ 代码化）**：派工前调一次 `permission.js`，按返回 `decision` 走：

```bash
node ${CLAUDE_PLUGIN_ROOT}/runtime/permission.js check \
  --project <项目根> --sender <ou_xxx> --intent <key>
# → {"decision":"allow|reject|confirm-needed|group-rejected","role":"admin|member","level":"...","reason":"..."}
```

- `allow` → 直接派工
- `confirm-needed` → 写 `pending_confirm`（15min 超时），回群让用户答 `Y/确认`
- `reject` → 回 `reason`（如"该操作需管理员授权"）
- `group-rejected` → bot 开关等敏感指令一律拒（详见 §开关指令的来源限制）

intent → level 映射规则（代码内置 + profile 可覆盖）：

| 来源 | 默认 level | 覆盖方式 |
|---|---|---|
| 内置 intent（hud / help / query_progress / query_todo / visual_bug_report / unknown） | `public` | 不可覆盖 |
| 内置 intent（bot_switch） | `group-rejected` | 不可覆盖 |
| 项目 intent（`profile.intents.<key>`） | `public` | `profile.intent_permissions.<key>: 'public' | 'admin' | 'admin-confirm' | 'group-rejected'` |

**典型项目级声明**（profile.intent_permissions 示例）：

```json
{ "deploy": "admin", "drop_db": "admin-confirm", "query_logs": "public" }
```

未在 `intent_permissions` 声明的项目 intent，默认按 **intent 名启发式**判定：名字匹配 `deploy*` / `publish*` / `release*` / `push_to_*` / `drop_*` / `delete_*` / `remove_*` / `reset_*` / `restart_*` / `kill_*` / `purge_*` / `prod*` / `*-deploy` / `*-prod` 等高危词 → 默认 `admin`（安全兜底，防 legacy profile 把部署类意图意外公开）；其他 → 默认 `public`。想放开高危名字给非 admin 调，显式声明 `intent_permissions.<key>: 'public'`。

## 意图路由

LLM 用语义理解匹配用户消息到 intent key，不做关键词硬编码。

**通用 intent**（cc-bot 自带）：`hud` / `help` / `query_progress` / `query_todo` / `visual_bug_report` / `bot_switch` / `unknown`。

**项目 intent**：`profile.intents.<key>`，键名自定义。典型示例：`deploy` / `run_tests` / `query_logs` / `compile_preview` / `check_build`。

**resolve / list 都走代码**（占位符替换 + doc_progress 文件存在检查 + 非空过滤自动处理）：

```bash
# 把 intent key 解析成「替换好占位符的可执行动作描述」
node ${CLAUDE_PLUGIN_ROOT}/runtime/intent.js resolve --project <项目根> --key <intentKey>
# → {"found":true,"description":"<占位符已替换的描述>","source":"builtin|project"}
# found:false → 回"当前项目未配置该操作"

# 'help' 意图触发时拿动态可用清单
node ${CLAUDE_PLUGIN_ROOT}/runtime/intent.js list --project <项目根>
# → {"items":[{"key":"...","hint":"...","source":"..."}, ...]}
```

LLM 职责收窄到「判语义匹配哪个 key」；占位符替换 / hint 摘要 / `doc_progress` 文件存在判断 / `_comment` 字段过滤全部在代码里。

支持的占位符（代码内置，加新占位直接改 `runtime/intent.js`）：`<project.root>` / `<project.doc_progress>` / `<paths.bot_temp_abs>` / `<paths.bot_temp_rel>` / `<chat_id>` / `<bot_app_id>`。

### 富文本（post）消息处理

飞书"文字 + 截图"合并为 `message_type: "post"`，content 渲染为文字行 + `[Image: img_v3_xxx]`。Monitor 放行 `text|post|file|image` 四类。处理流程：提取 `[Image: img_xxx]` → 按 §图片接收与下载 下载 → Read 截图 → 结合文字判意图。

### 文件（file）消息处理

群上传 xlsx/csv/doc 等时 `message_type: "file"`，content：

```
<file key="file_v3_xxx" name="xxx.xlsx"/>
```

步骤：
1. perl 或手工提取 `key=` 和 `name=`
2. 下载：
   ```bash
   lark-cli im +messages-resources-download --as bot \
     --message-id <om_xxx> --file-key <file_xxx> \
     --type file --output ./.cc-bot/bot_temp/<语义名>.xlsx
   ```
3. 读取：xlsx 用 `node -e "const X=require('xlsx');..."`；csv/txt 用 Read；doc/pdf 用对应库
4. 结合用户文字判断意图（常见：导入数据、参考文件改代码）

## 消息处理 SOP

收到 `NEW_MSG|{msg_id}|{sender}|{content}|{time}` 后：

### 最高优先级规则 0：回群 = 工具调用，宣告不算数

**回复群消息唯一算数的方式，是发起 `lark-cli im +messages-reply` 的 tool_use 并成功返回。** 在主会话里输出「我来回复」「我在群里回复他」「已回复」「bot 正常工作中」这类文字，**只有你自己看得到，不会发到群里，等于没回复**。

收到 NEW_MSG 后，**在调用回群工具之前，禁止输出任何「将要回复」的宣告性文本 —— 先调工具，再说话**。判断一条消息是否处理完，看的是「`+messages-reply` 是否成功返回」，不是「我是否说了要回」。每一条需要回应的 NEW_MSG，都必须以一次真实的 `+messages-reply` tool_use 收尾（inline 路径）；只在脑子里"打算回"而没有发起工具调用 = 这条消息被你丢了。

### 最高优先级规则 1：处理完立即推进 state.json

**"处理完"定义（三路径）**：
- inline：已发最终回复（`lark-cli +messages-reply` 成功）
- subagent：Agent 已派出（`run_in_background=true`）+ 占位回复已发
- 入队：已回"前面 N 个任务在跑"+ 任务写入 `agents.json.queue`

**处理完的下一个工具调用必须是 `Edit state.json` 写 `last_processed_time = {该条 time}`**，优先级高于下条处理、部署、任何"顺手再做"。漏推会导致 catch-up 时重派，同一任务跑两遍。

**格式：毫秒时间戳**（Number 或数字字符串），和 `NEW_MSG|...|<createTimeMs>` 末段一致。字符串时间需先转毫秒：`node -e 'console.log(new Date("2026-04-22 17:38:00 +0800").getTime())'`。**禁止混写字符串和毫秒** — fetch 比对会假阳/假阴。

### 最高优先级规则 2：处理前先 fetch 5 条核对（fetch_before_reply）

收到 NEW_MSG 前先 `lark-cli im +chat-messages-list --as bot --chat-id <chat_id> --page-size 5 --sort desc`，对比 `state.last_processed_time`，未处理消息按 `create_time` 升序逐条回 + 推进 state。Why：Monitor 密集时可能只推最新一条，单 push 处理会漏中间关键消息（2026-04-20 实战）。

**一次 fetch 覆盖多条**：Monitor 连发或前次 fetch ≤ 10s 内可复用结果。

**升级到 fetch 10 条**：用户情绪激动（连发"？？？"）/ 连续 ACK 无回应 / 主会话刚跑完 ≥3min 工具链。宁可多 fetch，不要漏看。

**state 推进纪律（v0.1.20，issue #9）**：fetch 拉到多条未处理消息时：
- **必须按 `create_time` 升序逐条 reply**（用 `+messages-reply --message-id <每条 om_xxx>`），不允许把 N 条合并成一条总结回复
- **每 reply 一条后立即推进 state.last_processed_time = 该条 ct**，逐条推；**严禁直接推到最新一条 ct 然后批量回**
- 跳号推进的后果：poll.js 的 `busy-held` 已 hold 但未 emit 的消息会被 `<= lastTime` 过滤永久丢，群里看不到任何反馈 = bot 装看不见。v0.1.20 已在 poll.js 加 `busy-held` 持久化兜底（绕过 lastTime 过滤），但主会话端纪律仍是第一道防线
- **NEW_MSG 去重**（v0.1.20 推论）：busy-held 释放时若 `ct < lastTime`，poll.js 会 emit 但写 `BOT_WARN|busy-held-late-release`。这种重复 emit 主会话需自行 dedup：fetch-before-reply 时若发现该 msg_id 在自己回复链上方（bot 已 reply 过），skip 不再回

### 最高优先级规则 3：bot 运行时禁用阻塞主会话的交互

**bot 运行时（state.paused = false），严禁使用 `AskUserQuestion` / `ExitPlanMode` 等阻塞等待终端输入的操作。** 需用户决策时，走群消息提问（`lark-cli +messages-reply`）。

**Why**：`AskUserQuestion` 阻塞主会话时不触发 `Stop` → `main-busy.lock` 无法正常解锁 → 10min 过期后若 statusline 心跳也陈旧，poll.js 进入降级模式（不 emit + 持续占位），群消息无人消费。群成员在群里不在终端，选项卡永远等不到响应（实测可达 6 小时）。详见 §主会话优先级 的降级模式说明。

### 完整流程

0. **fetch 核对**（见上，最高优先级 2）
1. **解析**：从 `|` 分隔字符串提取字段
2. **角色判定**：sender open_id ∈ `profile.members.admin_open_ids` → admin，否则 → member（白名单单源，无 cache）
3. **待确认检查**：读 state.json 的 `pending_confirm`（未超时）：
   - "Y"/"y"/"是"/"确认" → 执行
   - 其他 → 取消
   - admin 永久授权直接跳过 `pending_confirm`
4. **图片预处理**（content 含 `[Image: img_xxx]`）：逐个下载 + Read
5. **意图识别**：通用意图按 §意图路由，项目特定查 profile.intents
6. **分派决策**（见 §消息调度）：inline 自己回 / 派 subagent `run_in_background=true` / 入队。inline 继续走 step 7；subagent 和入队走 §消息调度 §派单动作 §入队动作，本流程到此结束（state 推进在那边单独处理）
7. **inline 执行**：
   - admin 触发危险操作 → 直接执行，不写 `pending_confirm`
   - member 触发"仅管理员"操作 → 拒绝
   - 其他危险操作的非 admin → 写 `pending_confirm`（15 min 超时）
   - `lark-cli im +messages-reply --as bot --message-id <msg_id>` 回复（依赖 reply 引用上下文，正文不具名 — 见 §角色与权限 §群里称呼）
8. **推进 state.json**：Edit `last_processed_time = time`（`time` = NEW_MSG 末段的 `createTimeMs` 毫秒戳，见 §最高优先级规则 1 格式规范）

### Bug 报告处理节奏（多 bug 密集会话）

1. **立刻确认收到**（1 轮内）：回"收到 {name} 反馈的 {bug 简述}，正在定位..."
2. **定位根因**：读文件、查日志，必要时用 profile.intents 里的复现类意图（如 `page_check` / `run_tests` / `query_logs` 等，看 profile 实际配置）
3. **修复**：Edit 代码文件（在 profile.project.root 下）
4. **回结果 + 下一步**：报"已修复 {xxx}，原因 {根因}"，根据改动范围提示是否需要新二维码 / 部署

多条 bug 并行时逐条独立回复（不要合并成"已修完 5 个问题"），每条回复后立即推进 state.json。

### Bug 信息不足的引导

用户只说现象不说上下文（例："显示的名字不对"）时，先引导：

> "方便补充一下 ①哪个页面 ②操作步骤（如何触发） ③截图 吗？这样能更快定位。"

拿到三要素再走修复流程。依然歧义时继续追问具体字段，不要盲猜。

### 多条消息积压处理（防漏规则）

一次轮次收到多条 NEW_MSG（堆积）时：按 §最高优先级规则 1/2 逐条处理 + 逐条推进 state，**按 create_time 升序回复**（不按 Monitor 到达顺序）。

### ACK 消息立刻响应（ack_msg_action）

短消息（≤12 中文字）调代码判：

```bash
node ${CLAUDE_PLUGIN_ROOT}/runtime/ack-detect.js detect --text "<消息内容>"
# → {"isAck":true|false, "kind":"yes|continue|ok|thanks"|null, "suggestedReply":"好|继续中|..."|null, "confidence":0..1}
```

`isAck:true` 时：① 立刻推进 `state.json.last_processed_time`；② 回 `suggestedReply`（≤15 字，`thanks` 类返 null 不回避免回复风暴）；③ 马上接着干上一轮的下一步。

**Why**：ACK = 绿灯不是红灯。多批次任务里每一次 ACK 都是下一批启动信号；沉默会被严重不满（2026-04-20 实战复盘：负责人回「可以，继续」被误当成"无需处理"，18 min 后遭严厉批评）。

`isAck:false` 时按 §完整流程 走常规意图识别。停止词（"不"/"取消"/"等等"/"no"）即便短也不算 ACK，CLI 内部已处理。

### Monitor 异常时 API 兜底

polling 架构下，Monitor 工具托管的 `poll.js` 是主回路，每 30s 主动 HTTP 轮询拉消息 → emit NEW_MSG 到 stdout → notification 到主会话。**通常情况下 Monitor push 可靠**（不再有老架构的"Bash background stdout→pipe 压缩断开"问题）。

但以下三种场景仍需 API 兜底（直接调 `lark-cli im +chat-messages-list` 对比 `state.json.last_processed_time`，不走 poll.js / poll.emitted 通道）：

1. **Monitor task 挂掉**：`TaskGet(task_id)` 返回 `Task not found` / `failed` / `completed`（非 persistent 内预期状态）
2. **poll.js 连续失败告警**：主会话收到 `BOT_ERROR|poll.js|lark-cli 连续失败 N 次` notification
3. **用户主动问"群里有消息吗 / 新消息吗 / hello?"**：不凭记忆回答，立即 fetch 核对（和「最高优先级规则 2」的 fetch_before_reply 一致）

`poll.emitted` 是 poll.js 内部去重表，**绝不要手动清空**（会导致历史消息被当新消息重推刷屏）。

**Monitor push 与 API 兜底结果冲突时以 API 为准。**

## 消息调度（多 agent 并发）

主会话 = 调度器本身，**不自己跑重活**。收到 NEW_MSG 后判断：能派 subagent 就 `Agent(run_in_background=true)` 后台派出去，主会话立即解放处理下一条；不能派就排队。目标是多条群消息并行处理，主会话永远不被单条卡住。

### 核心概念

- **slot**：同时允许跑的逻辑任务数，默认 `slots_max = 3`。一条用户消息 = 1 slot，不论内部 fan-out 几个 subagent
- **registry**：`.cc-bot/runtime/agents.json`，记录 running / queue
- **tag**：任务登记的资源标签，冲突判定的钥匙
- **fan-out**：单条用户消息内部拆多个并行 subagent，上限 3，不占额外 slot

### agents.json 格式

```json
{
  "slots_max": 3,
  "running": [
    {
      "id": "agent_<msg_id>",
      "msg_id": "om_xxx",
      "user_name": "A",
      "user_open_id": "ou_xxx",
      "intent": "fix_login_bug",
      "tags": ["write:src/auth", "net:push"],
      "started_at": "2026-04-22T10:00:00Z",
      "subagent_count": 1
    }
  ],
  "queue": [
    {
      "msg_id": "om_yyy",
      "user_name": "B",
      "user_open_id": "ou_yyy",
      "intent": "refactor_auth",
      "tags": ["write:src/auth"],
      "queued_at": "2026-04-22T10:01:00Z",
      "reason": "conflict:write:src/auth"
    }
  ]
}
```

文件读写由 `runtime/dispatch.js` 接管（v0.1.25+，主会话不直接 Edit），缺失自动建空态。重启 bot 时 registry 全清（和 `poll.emitted` 同策略，subagent 会随主会话 stop 失去监听）。

**字段格式规范**：
- `started_at` / `queued_at`：**ISO 8601 字符串**（如 `"2026-04-22T10:00:00Z"`），用于人类可读 debug 和超时判定（主会话用 `new Date(x).getTime()` 换算）
- `state.json.last_processed_time`：**毫秒时间戳**（见 §最高优先级规则 1）——两者格式故意不同，不要混用

### 分派决策表

| 消息类型 | 处理 | 占 slot |
|---|---|---|
| 控制类（群里发"开/关 bot"）| 拒绝（§开关指令的来源限制）| 否 |
| 查询 / 闲聊 / 状态 / 单文件小改动（typo / 1-3 行 Edit）| 主会话 inline 直接回 | 否 |
| 跨文件改动 / build-test 循环 / 部署 / 发码 / 大搜索 | 派 subagent `run_in_background=true` | 是 |

判定阈值：**预估 ≤ 3 个 tool_use + 单文件 + < 30s 走 inline**，否则 subagent。上下文 > 70% 时阈值收紧（倾向 subagent 保主会话）。

### 派单决策（v0.1.25+ dispatch.js 接管 agents.json 全生命周期）

1. **Fetch 核对**（§最高优先级规则 2 不变）
2. **意图 + inline/subagent 判定**（按上面 §分派决策表 阈值；inline 路径走 §完整流程，不进 dispatch）
3. **生成 tags**（subagent 才需要）—— 抓"这件事最怕被谁同时动"就够：
   - `read:<path>` / `write:<path>` — 路径冲突（按目录段，read-read 不冲；prefix 匹配在 dispatch.js 内部）
   - `mcp:<name>` / `port:<n>` — 独占资源
   - `net:push` / `exclusive:git` — 发布 / git 独占
4. **调 dispatch.js register**：

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/runtime/dispatch.js register \
     --project <项目根> \
     --task-json '{"msg_id":"<om_xxx>","user_open_id":"<ou_xxx>","user_name":"<name>","intent":"<key>","tags":[...]}'
   # → {"action":"dispatch|queue|reject","reason":"...","taskId":"agent_om_xxx","queuePosition":N|null}
   ```

   CLI 内部一次性原子完成：评估 slot 满 / tags 冲突 / 同 user 串行 → 写 `agents.json`（running 或 queue）→ 返 action。**主会话不再手动 Edit agents.json**。

   action 含义 + 应对：
   - `dispatch` → 派 worker（步骤 5）
   - `queue`    → 回群"收到。前面 `queuePosition` 个任务在跑，排到后开始"，推 state，本响应结束。reason 见下
   - `reject`   → reason=`queue_full`，回"任务队列已满（10 条），稍后再试"

   reason（queue 时）：`slot_full` / `conflict:path-overlap:...` / `conflict:exclusive-tag:...` / `user_serial`。

5. **dispatch 派单动作**：
   - 回群占位（流式卡片模式下跳过此步，worker 起卡即占位）
   - 推 `state.json.last_processed_time = msg.create_time`
   - 调 `Agent(subagent_type:'cc-bot:worker', run_in_background:true)`，prompt 只传 4 字段（任务描述 / `项目根` / `msg_id` / `plugin_root = ${CLAUDE_PLUGIN_ROOT}`）—— 其他规范都在 worker.md
   - 本响应结束，接下条 NEW_MSG

### Fan-out（单消息多 subagent 并行）

一条用户消息提多件事可以拆。前提：子任务无依赖 + tags 两两无交集 + 数量 ≤ 3。

派法：同响应里多个 `Agent` tool_use；register 时一次性 `"subagent_count": N`、`"tags"` 是所有子任务 tags 并集（影响后续冲突判定）。

### 完成回收（dispatch.js complete）

subagent 完成时 `run_in_background` 自动 notify 主会话，调代码：

```bash
node ${CLAUDE_PLUGIN_ROOT}/runtime/dispatch.js complete \
  --project <项目根> --task-id <agent_om_xxx>
# → {"removed":true,"promoted":<Task|null>}
```

CLI 自动从 queue 头扫第一个可 promote 的（slot 有空 + 不冲突 + 同 user 不在剩余 running + 同 user 队前没排过 → 保 FIFO），把它写回 running 返回 `promoted`。`promoted` 非 null → 按上面 dispatch 步骤 5 派 promoted 那条；null → 啥都不做。

fan-out 任务（`subagent_count > 1`）：等**所有**子 agent 完成再调 complete 一次。

### 队列上限 / 超时

- 队列 10 上限（QUEUE_LIMIT，dispatch.js 常量）：register 返回 `action:'reject', reason:'queue_full'` 时回"任务队列已满，稍后再试"
- 单任务预计 > 30min（大型部署）先警告用户确认再派；卡住无响应靠 §Monitor 异常重启 兜底

### 与 §Agent 优先策略 的关系

两个不同维度，不混：

- §Agent 优先策略（§运行时节奏内）：**主会话内部省 token**派 Agent（跨目录 Grep 派 Explore），**不占 slot**、不登记 registry、生命周期在一次响应内
- §消息调度（本节）：**群消息任务级**派单，**占 slot**、登记 registry、跨响应存在（`run_in_background`）

同一次响应里两者可并存：inline 处理时内部可以再派 Agent 读文件。

### 主会话优先级（v0.1.6+）

**目标**：CC 主窗口的对话任务不被群消息打断。90% 场景是群里单用户对话，slot 级并发实际走不满，但"主窗口正在改代码，群里发消息立刻插队打断"是真实痛点。

**"主窗口对话"的精确定义**：
- 概念上指**开发人员在 CC 主窗口主动键入**的 prompt（人类对话）
- 实现上**以 CC `UserPromptSubmit` hook fire 为准**（CC 不区分 prompt 来源）—— `/loop` / `ScheduleWakeup` / `CronCreate` / `RemoteTrigger` / `claude -p` / Task/subagent 完成（bug #16952 假 fire）等自动场景也会触发锁，一视同仁
- Monitor 事件注入（群消息 push 路径）**不走** `UserPromptSubmit`，不会自锁

**这不是 bug，是设计**：主会话是单线程，上述"自动任务"场景下主会话本就被占用，群消息 emit 过去也没法响应。锁只是把"主会话忙没理你"变成群里显式占位（从 30 条文案池随机一条，详见 `runtime/poll.js` `BUSY_PLACEHOLDERS`），体验更好不更差。

**机制**（poll.js 层拦截，主会话无感知）：

1. CC hook 注册在 `~/.claude/settings.json`（由 `/cc-bot:setup` step 9 幂等注入）：
   - `UserPromptSubmit` → `node ${CLAUDE_PLUGIN_ROOT}/runtime/main-busy.js lock` 写 `.cc-bot/runtime/main-busy.lock`
   - `Stop` → `node ${CLAUDE_PLUGIN_ROOT}/runtime/main-busy.js unlock` 删锁 + 删通知标志
2. poll.js 每 tick 开头 `checkMainBusy()` 返回 `{ busy, degraded, lockTs }`：
   - 锁存在 + 未过期 → **仍 fetch 但不 emit**（消息不进主会话事件队列）；按下方占位策略决定是否发占位
   - 锁存在 + 过期（> 10min）→ 查 `hud-stdin.json` 心跳：
	     - 心跳新鲜（< 5min）→ **孤儿锁**（Stop 漏 fire 或 unlock 失败），安全清锁 + 恢复 emit；写 `events.log` `BOT_WARN|main-busy-lock-expired-orphan`
	     - 心跳陈旧/缺失 → **降级模式**（主会话极可能卡在 `AskUserQuestion` 等阻塞交互）：锁不删、不 emit、保持 busy（`degraded=true`）；写 `events.log` `BOT_ERROR|main-busy-lock-expired-degraded`。Stop 触发后正常解锁恢复
   - 锁不存在 → 正常 emit NEW_MSG

   **占位策略**（v0.1.19+，分层语义，issue #6 #7 一并解）：
   - `profile.im.busy_placeholder === false` → 全关 opt-out（普通态 + 降级态都不发）
   - **普通忙碌**：`per-lock dedup` — 同一 lock acquisition（同 `lockTs`）至多发 1 条；外加 5min 全局节流兜底，防 hook 高频 lock churn（多 turn 密集时 issue #6 的场景）击穿 per-lock dedup
   - **降级模式**：5min 周期心跳续发，保留卡死场景的"还活着"信号（v0.1.15 设计，issue #1）
3. 主会话响应完（Stop）→ 锁删除 → 下一 tick（≤ 30s）恢复正常 fetch，积压消息通过 `poll.emitted` 去重机制补 emit，不会丢

**为何 hook 走 `~/.claude/settings.json` 而不是 plugin `hooks.json`**：CC bug #10225 — plugin 声明的 `UserPromptSubmit` hook 完全不 fire。`main-busy.js` 自带"非 cc-bot 项目 silent skip"（检查 `.cc-bot/` 存在），全局注册对其他项目无副作用。

**主会话做什么**：什么都不用做。本机制完全由 poll.js + hook 脚本自主运转，不改 agents.json、不改 §消息调度 主流程。主会话只需知道：群消息静默不是丢了，是主窗口占用期间被主动延迟，Stop 后会补 emit。

**关键不变式**：
- 锁期间 poll.js **不 append poll.emitted**（v0.1.6+），改写 `poll.busy-held`（v0.1.20+）；解锁后下一 tick 从 `poll.busy-held` 重 emit，绕过 `<= lastTime` 过滤防主会话越过 state 时静默丢（issue #9）
- `main-busy-notified.flag` 是**全局占位发送时间戳**（v0.1.16+），与 lock 生命周期解耦；`unlock` 不再删它（删了会导致下一次新 lock 立刻又发占位 → issue #6 多 turn 刷屏）。per-lock 去重独立用 `lockTs` 进程内变量
- `state.last_processed_time` 只由主会话推进；poll.js 不动它（推进纪律见 §最高优先级规则 2）
- `poll.busy-held` 释放 emit 时若 `ct <= lastTime`，poll.js 写 `BOT_WARN|busy-held-late-release`，表示主会话可能已通过 fetch-before-reply 处理过；重复 emit 由主会话端 dedup（见 §最高优先级规则 2 "NEW_MSG 去重"）

**测试 caveat**：`!` 前缀 bash 命令 UserPromptSubmit / Stop 毫秒级 fire，跨不了 poll tick（30s），会漏测。测本机制用真实 Claude prompt（≥30s 输出）。

## 运行时节奏（长会话反崩溃）

### Agent 优先策略（默认思路）

> 本节 = **主会话内部为省 token 派 Agent**（不占 slot、不登记 registry、生命周期在一次响应内）。群消息任务级派单见 §消息调度。

Bot 长跑时，主上下文每省一点，长期累积明显。**即便还在 < 70% 正常档，以下场景也默认走 Agent**，让主会话只收回 summary：

| 场景 | 走 Agent | subagent_type |
|------|---------|---------------|
| 跨目录/多轮搜索（> 3 次 Grep/Glob） | ✅ | Explore |
| 长文档完整阅读（≥ 200 行的 PRD/架构/进度）→ 只要 summary | ✅ | Explore |
| 独立子任务（代码审计、E2E 脚本、性能分析、架构评估） | ✅ | general-purpose |
| 多个独立任务可并行 | ✅ 一次多开 | 按任务选 |
| 实现规划好的任务链 | ✅ | superpowers:executing-plans 风格 |

**直接在主会话做（派 agent 反而浪费）：**

- 已知路径的单个小文件 Read（< 200 行）
- 目标明确的**单次** Grep / Glob
- **即将 Edit** 的文件（主会话必须先 Read 过）
- 简单 Bash（编译/部署/发消息）
- 已知字段位置的精准读取（用 `offset`/`limit`）

**派 agent 的 prompt 规范：**

- 明确给出目标和返回格式（"找 X 在哪些文件用，返回 file:line 清单"）
- 要求 summary 而非倾倒原文（"回报控制在 200 字内"）
- 涉及代码改动时**绝不让 agent 写文件**——让它返回"应该改什么"，主会话自己 Edit

### 上下文用量监控（兜底）

看 `hud-stdin.json` 的 `context_window.used_percentage` 做被动兜底：

| 百分比 | 策略 |
|-------|------|
| < 70% | 正常工作；按"Agent 优先策略"派活 |
| 70-82% | 避免大段 Read（用 Grep + offset/limit 精读），长文件**一律**交 Agent |
| 82-92% | 只做必须的工具调用，大的 page_data、全文件 Read 都走 Agent；答群消息更短；优先 commit |
| > 92% | **立刻停下非关键动作** → 发群"上下文快满，准备交接，请开发人员 `/clear` 或 `/compact`" → commit → 推进 state.json → 等指令 |

反例：92% 还在跑 compile/upload/深度 Read — 中途被 compact 切走，丢当前上下文，重启后看不到刚才发生了什么。

### 定期提交推送

**触发时机：**

1. **修完一个独立 bug/feature** — 立刻 `git add 具体文件 && git commit && git push`。不要累积 5 个 bug 一次性提交
2. **群里发完新二维码/upload** — 证明版本已对外，代码状态必须同步到 remote
3. **阶段切换** — 每个阶段任务结束 commit，不跨任务混提交
4. **上下文用量过 80%** — 即便任务未完成也先 commit 落袋为安

**规范：**

- `git add` 指定文件，不要 `-A` / `.`（防止误提 .cc-bot/bot_temp、.secret.json 等）
- commit message：`fix:` / `feat:` / `refactor:` / `chore:` + 一句话主旨 + 空行 + 列出改动项
- 工程改动（SKILL / poll.js / adapter 等）可合进 fix/feat commit，但不上群
- push 失败不重试，发群"push 失败：{错误}，需要你检查网络/凭据"

## 回复格式

- 简洁工具风，只返回结果。首行一句话结论（"已修"/"已部署"/"失败：<原因>"），细节用户问再给
- 避开四类长病：**修改流水账** / **主动解释 why** / **汇报内部动作** / **客套和复述** —— 群成员都不想看
- 代码 / log / 长输出走截图或独立 code block，不混叙述
- 图片：`lark-cli im +messages-send --as bot --chat-id <群ID> --image <相对路径>`

### 情绪价值（与简洁并不冲突）

群里是活人，不是 CLI。对方带情绪时，**先接住情绪再展开技术**，否则"精准"的回复反而把人越推越远。

**四类情绪信号 → 对应动作**

| 信号 | 示例 | 对应动作 |
|------|------|---------|
| **不耐烦 / 被指挥烦了** | "别什么都指挥我"、"你自己去干" | 立刻道歉 + **自己能做的直接做**，不再甩操作步骤；不能做的**明确说自己没权限**，给最短路径 |
| **质疑流程 / 你搞错了** | "咋回事儿"、"不是说好的 X 吗" | **先承认"是我理解偏了/漏了"**，再用**一句话复述对方期望**让她确认，再做 |
| **重复遇到同个坑** | "还是显示..."、"又不行" | **不要列①②③追问**，直接**改一条路径试**；失败再换；每步发短进度条（≤10 字） |
| **明显焦虑 / 时间压力** | "快过审了"、"客户在等" | 砍掉一切可选步骤，**只给能立刻用的那一条**；非关键澄清放后面 |

**措辞尺度**

- 道歉直接：「抱歉」「是我想错了」「我漏了」— 不要"感谢指出"这种客套
- **不过度道歉**：一件事只道歉 1 次；道完立刻进入动作，不要"再次抱歉"；小错（typo / 格式小失误 / 单字误读）直接改，别道歉；连续对话里不要每条都带"抱歉"开头 —— 反复道歉反而让人觉得心虚
- 允许温和的单字符情绪标记：`🙏`（致歉）、`✅`（完成）— 一条回复最多 1 个，紧贴动作词（"修好了 🙏"），不做装饰
- 禁用彩虹式 emoji、拟人语气（"小助手正在帮您..."）、感叹号堆砌

**与简洁原则的边界**

- 情绪价值 ≠ 啰嗦。一句"抱歉，是我漏了"就够了
- 动作**永远比情绪重要**：承认 → 立刻开工 → 做完报结果
- 对方如果是冷静提问（非情绪），**不要硬加道歉和 🙏**，正常工具风即可

### 工程性改动不发群（重要）

**SKILL.md / 监听规则 / bot 自身行为调整 / profile 改动等工程改动，不发群通知。只有业务产出（bug 修复、功能上线、新二维码、提审版本）才发群。**

反例：修复 bot skill、调整占位规则、切换 profile 的"已完成"消息都不发群。开发人员在主会话直接确认即可。

### 状态提醒（占位回复）

**耗时操作（≥5 秒）前发一条 ≤10 字纯文本占位（如"处理中"、"排查中"、"编译中"），不要 emoji、不要花哨装饰。**

规则：
1. 占位后马上开工，不要连发两条占位
2. 完成后再发结果，占位只是"我收到了"的信号
3. 涉及"等你确认"类后停下等回复，不要自己继续
4. 同一会话内占位措辞可微调（"处理中" / "定位中" / "改代码中"），保持简短

### 进度流式汇报（长任务反黑盒）

任务跨多阶段 / 单动作 ≥30 秒 / 多 bug 连发 / 后台 agent 运行时，额外广播进度：

1. **阶段性汇报**：2+ 阶段任务每进入新阶段发一条短文本，仅阶段切换时发
2. **长动作心跳**：单动作 ≥30 秒开工前发"开始 XX"；实际超 1 min 中途补"还在忙 XX（已 1 min）"，每分钟最多 1 条
3. **多 bug 编号**：一次连发 3+ 条时先回"收到 N 条，按序处理 ①{简述} ②{简述} ③{简述}"；每完成一条发"①完成，继续 ②..."
4. **agent 派单告知**：启动后台 agent 时同步"已派 agent 做 {任务}，预计 {N} min"；结束立刻发简要结论
5. **失败兜底**：任何一步失败立刻发"{XX} 失败：{一句话原因}，转方案 B / 等你确认"，禁止沉默重试

**时间线示例（每条 ≤15 字纯文本）：**

```
用户：排行榜名字对不上
bot ：定位中
bot ：改 service 层
bot ：开始部署
bot ：部署失败：依赖缺失，换 MCP 重试
bot ：部署完，出码
bot ：[preview-qr.png]
```

## 执行细节

### 统一截图目录

**所有** bot 产生/下载的图片统一放 `./.cc-bot/bot_temp/`（相对于项目根的 cc-bot 专属临时目录，避免污染项目根；`.cc-bot/runtime/` 只放状态/锁/缓存，不塞图片）。

| 场景 | 输出路径 |
|------|---------|
| 预览二维码 | `./.cc-bot/bot_temp/preview-qr.png`（或当前 profile 要求的绝对路径） |
| 页面手动截图 | `./.cc-bot/bot_temp/<语义名>.png` |
| 接收 bug 截图 | `./.cc-bot/bot_temp/bug-<语义名>.png` |
| 发图到群 | `./.cc-bot/bot_temp/<名>.png` |

### 发图相对路径（避坑）

lark-cli `--image` 只接受相对路径，绝对路径（`D:/...`）会报 `--file must be a relative path within the current directory`。

```bash
lark-cli im +messages-reply --as bot \
  --message-id om_xxx --image ./.cc-bot/bot_temp/preview-qr.png
```

### 图片接收与下载

群里用户发"文字 + 截图"时 content 含 `[Image: img_v3_xxx]`。下载：

```bash
lark-cli im +messages-resources-download --as bot \
  --message-id om_xxx \
  --file-key img_v3_xxx \
  --type image \
  --output ./.cc-bot/bot_temp/bug-<语义名>.png
```

关键参数：
- `--as bot`：bot 身份下载（群消息 bot 能读）
- `--message-id`：图片所在消息的 om_xxx（不是 img_key）
- `--file-key`：从 `[Image: img_xxx]` 提取的 img_xxx
- `--type image`（视频 `--type video`，本 bot 不处理）
- `--output`：相对路径，`./.cc-bot/bot_temp/` 前缀，语义化短名

**下载后必须先查尺寸再决定是否 Read**（v0.1.11+，避免 >2000px 图片污染会话历史触发 API dimension limit 整轮 tool 阻塞）：

```bash
node ${CLAUDE_PLUGIN_ROOT}/runtime/check-image-size.js <绝对路径>
```

stdout 单行输出 + exit code：

| 输出前缀 | exit | 动作 |
|---------|------|------|
| `OK <w>x<h> <format>` | 0 | 正常 `Read <绝对路径>`，结合文字判意图后回复 |
| `TOO_LARGE <w>x<h> <format>` | 1 | **禁止 Read**，纯文字回群：`收到截图，但长边 X px 超过 2000px 限制（再大会让我处理出错），麻烦重发一张缩到 2000px 以内的。手机系统截图工具默认输出一般就符合` |
| `UNKNOWN_FORMAT <reason>` | 2 | 非 PNG/JPEG/GIF（如 WebP/HEIC/AVIF），可谨慎 Read（多数手机相册 WebP 在 ~1500px 内安全） |
| `ERROR <reason>` | 3 | 工具报错，告诉用户重试一次或换格式重发 |

多图依次 download + check + Read，任一张 TOO_LARGE 都立刻停下回纯文字。

> **为什么必须查尺寸而不是直接 Read**：dimension_limit 是 Claude API 的会话级硬约束 — 一旦把超大图喂进会话历史，**之后每一轮 API 请求带上这段历史都会重复触发该报错**，整轮 tool 全死、bot 沉默，唯一出路是 `/clear` 重开会话。预防成本（一条 ~30ms 的 node 命令）远小于翻车成本（会话作废）。

### Shell 安全规范

> 跨平台统一写法。下面标注 ⚠️Win 的坑仅在 Windows Git Bash 上出现，macOS/Linux 系统 bash 无此问题；但为统一规范，所有平台都按下面规则写。

**禁止：**
- `$'...'` 语法 ⚠️Win — Windows Git Bash 支持不稳定，`$'\n'` 会泄漏为字面 `\n` 文本（已实测翻车：上线通知群里显示 `cc-bot 已上线\n模型: ...`）。macOS/Linux bash 原生支持，但保持规范一致用 JSON content 替代
- 单引号内嵌中文或特殊字符 ⚠️Win — Windows 终端编码不一致
- `--text "...\n..."` 内嵌 `\n` 转义符 ⚠️Win — Windows 下不被解为真换行，落群里是字面 `\n`（多行走下方 JSON content 或双引号 + 字面换行）

**多行消息必须用 JSON content：**
```bash
lark-cli im +messages-send --as bot --chat-id X \
  --msg-type text \
  --content '{"text":"line1\nline2\nline3"}'
```
- 外层 bash **单引号**（shell 不解析内容）
- 内层 JSON **标准 `\n`** 转义（lark-cli `JSON.parse()` 还原为真换行）
- `+messages-reply` 同理
- **--text 内容含反引号 `` ` ``** — 双引号里的反引号会触发 command substitution，改用中文引号「」或转义 `` \` ``

**推荐：双引号 + 字面换行**（多行直接在引号内换行）
```bash
lark-cli im +messages-reply --as bot --message-id om_xxx --text "第一行
第二行"
```

**双引号内需转义：** `"` → `\"`、`$` → `\$`、`` ` `` → `` \` ``、`\` → `\\`。中文 / `|` / `/` / `%` / 空格无需转义。

## HUD 状态推送

HUD 数据由独立插件 **cc-hud** 写入 `.cc-bot/runtime/hud-stdin.json`。cc-bot 本身不生产 HUD 数据，只消费。

### HUD 不可用时的处理（hud-stdin.json 缺失或空）

**群回复**（按 `profile.im.locale` 选）：`zh-CN` → "HUD 数据暂不可用"；`en-US` → "HUD data is not available"。不贴命令（群成员看不懂）。

**主会话同时输出工程提示**（仅 `/cc-bot:start` 拼 HUD 失败 / 群里问 HUD / 主动调试 时触发；`/cc-bot:stop` 不触发）：
- 检测 shim：`grep -q 'cc-bot.*statusline\.js' ~/.claude/settings.json` 判断已注册 / 未注册
- **未注册**：提示"重跑 `/cc-bot:setup`（step 7 会注册），重开 CC 会话，下次 statusline tick 生成 hud-stdin.json"
- **已注册但文件缺失**：提示排查三点 — ①CC 刚启动未 tick（跑一次工具调用）②shim 路径错（查 settings.json 的 `statusLine.command`）③shim 静默失败（终端手跑 `echo '{}' | node <路径>/runtime/statusline.js`）

按 §工程性改动不发群，工程提示只在主会话显示，不进群。

### cc-hud 与 statusline 的关系

cc-hud 是独立 statusline **渲染器**（stdin JSON → stdout，不写文件）。cc-bot 的 shim 包一层：先落盘 stdin JSON 给 bot 用，再透传给 cc-hud 渲染状态栏。互不冲突可共存，装不装 cc-hud 不影响 bot HUD 群消息功能（只影响状态栏美观）。

### HUD 可用时的群消息格式

群里发"状态"或"HUD"（或英文 `hud` / `status`）触发。读 `hud-stdin.json`，**按 `profile.im.locale` 选语言模板**（缺省 `lark`=`zh-CN` / `slack`=`en-US`，与 §开关通知 一致）。

**zh-CN**：
```
Claude Code HUD
CC: v2.1.142
模型: Opus 4.7 (1M context)
上下文: ██░░░░░░░░ 13%  (130K / 1M)
5h 额度: ██░░░░░░░░ 18% (剩 3.2h)
7d 额度: ░░░░░░░░░░ 2%  (剩 6.9d)
```

**en-US**：
```
Claude Code HUD
CC: v2.1.142
Model: Opus 4.7 (1M context)
Context: ██░░░░░░░░ 13%  (130K / 1M)
5h limit: ██░░░░░░░░ 18% (3.2h left)
7d limit: ░░░░░░░░░░ 2%  (6.9d left)
```

HUD 不可用时（§HUD 不可用时的处理）：`zh-CN` → "HUD 数据暂不可用"；`en-US` → "HUD data is not available"。

### 字段来源

| 展示项 | 字段 | 备注 |
|--------|------|------|
| CC 版本 | `version` | 直接用 |
| 模型名 | `model.display_name` → fallback `model.id` 映射 | 见下方 |
| 上下文 % | `context_window.used_percentage` | 整数百分比 |
| 上下文绝对值 | `current_usage` 总和 / `context_window_size` | 合成 `130K / 1M` |
| 5h / 7d | `rate_limits.five_hour.*` / `seven_day.*` | `resets_at - now` 秒差 ÷ 3600 |

### 模型显示规则

**优先 `model.display_name`**（CC 2.1.112+ 可靠）。缺失或滞后时按 `model.id` 前缀映射：`claude-{opus|sonnet|haiku}-*` → `Opus/Sonnet/Haiku X.X`；末尾 `[1m]`（CLI 为 1M 变体动态拼接）→ 补 ` (1M context)`，无后缀补 ` (200K context)`。上下线通知同此规则。

### 进度条

`█` × round(percent/10) + `░` 补满总宽 10。**禁止展示 cost 费用字段**（群成员看不懂）。

## 异常处理

- lark-cli 回复失败 → 跳过继续
- 操作超时（>2 min）→ 回"操作超时，请稍后重试"
- 状态文件损坏 → 重建默认状态 `{"last_processed_time":"0","pending_confirm":null,"paused":true}`
- `.cc-bot/profiles/active.json` 缺失 → 回"未配置 profile，请先复制 template.json 或切换项目"

### Monitor 异常重启

Monitor persistent task 意外退出（群消息长时间无 NEW_MSG 推送、用户问"群里有消息吗"时发现 bot 不响应），按以下步骤重开：

1. **取 task_id**：先 Read `.cc-bot/runtime/state.json.monitor_task_id`；有值 → 直接 `TaskGet(task_id)`；无值 / 值已失效 → `TaskList` 找描述含 `poll.js` 的 persistent task 作为兜底
2. **按状态分支**：
   - `failed` / `completed` → 走下一步重启
   - `running` 但 poll.js 内部卡死 → `TaskStop(task_id)` 再走下一步
   - `running` 正常 + tick 刚发过消息 → Monitor 没问题，按顺序排查：① `lark-cli auth list` 看 token 是否过期；② Read `profile.active.json` 看 `im.chat_id` / `im.bot_app_id` 字段是否被误改
3. **重新启动**（命令与 `/cc-bot:start` 完全一致）：
   ```
   Monitor(
     command: node ${CLAUDE_PLUGIN_ROOT}/runtime/poll.js --project <profile.project.root>,
     description: cc-bot poll.js（飞书群轮询）,
     persistent: true,
     timeout_ms: 3600000
   )
   ```
4. **回写 task_id**：Monitor 返回新 task_id → Edit `state.json.monitor_task_id`
5. **验证**：下一个 30s 周期观察 stdout 是否有 `NEW_MSG` / `BOT_INFO` / `BOT_ERROR`；仍无输出则 `/cc-bot:stop` + 人工排查 lark-cli auth 或 profile 字段

**不要做的事**：不要 `kill` 所有 node 进程（会跨项目误杀）；不要删 `.cc-bot/runtime/poll.emitted`（会导致历史消息被当新消息重推）。
