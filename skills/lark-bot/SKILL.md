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

群里收到开关意图 → 不执行，回复"开关指令请从 Claude Code 主会话发起"。这条优先于 `feedback_lark_bot_admin_auto_auth`。

## 架构

Claude Code `Monitor` 工具托管 `node ${CLAUDE_PLUGIN_ROOT}/runtime/poll.js --project <root>`，每 30 秒通过 `IMAdapter.listRecentMessages()` 拉最近群消息（飞书 adapter 底层调 `lark-cli im +chat-messages-list` HTTP 短连接），对比 `state.last_processed_time` + `poll.emitted` 去重，emit `NEW_MSG|...` 到 stdout，Monitor 捕获为 notification 推送主会话。

```
主会话 ── Monitor(persistent) ── node poll.js ── 每 30s IMAdapter.listRecentMessages() (HTTP)
                                              ├─ state.last_processed_time + poll.emitted 去重
                                              └─ stdout: NEW_MSG|msg_id|sender|content|ts
                                                         ↓ Monitor → notification
                                                   主会话 → 意图判定 → adapter.sendText / bash lark-cli
```

**IM Adapter 层**：`adapters/base.js` 定义接口（`listRecentMessages` / `sendText` / `sendImage` / `downloadResource` / `getUser`），`adapters/lark.js` 实现飞书版（包 `lark-cli`）。poll.js 读 `profile.im.type` 实例化对应 adapter。未来加企业微信/钉钉/Slack 只需新增 adapter 文件 + profile 里改 `im.type`。

**为什么走 HTTP 短连接**：`lark-cli event +subscribe` 的 WebSocket 长连接在 Clash/Verge 等 vpn 代理下被静默断流，`LARK_CLI_NO_PROXY=1` 对 WS 客户端无效。HTTP 短连接走代理稳定。依据 memory `feedback_single_monitor_polling_architecture`。

### poll.js 三层防御（禁止删除）

应对 2026-04-20 polling 架构三坑（见 memory `feedback_from_fantown_polling_architecture_traps`）：

1. **PID lockfile 单例锁** — 启动写 `.cc-bot/runtime/poll.pid`，若已有活进程则 `exit 0`；每 tick `verifyLock()` 校验 pid 仍是自己，被抢则自杀
2. **stdout.writable + EPIPE** — Monitor 管道断时 tick 前自检 `process.stdout.writable`，或 `stdout.on('error', EPIPE)` 立即 `exit 1`，防孤儿污染 `poll.emitted`
3. **state 未来值防御** — `last_processed_time > Date.now()+60s` 自愈降到 `now-60s`，emit `BOT_ERROR|poll.js|state-future-timestamp|...`

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

**关键：上线通知不依赖 Monitor 是否 running**（Monitor 即便挂了，poll.js 也会启动，通知发了就是发了）。所以这几个动作能真并行。

#### 具体步骤

1. **读 profile**（单次 Read）：获取 `im.chat_id` / `im.bot_app_id` / `project.root` / `paths.bot_temp_abs` 等
2. **单批次并行发起**：
   - Edit `.cc-bot/runtime/state.json`：`paused=false, monitor_task_id=null`
   - Bash: `mkdir -p <bot_temp_abs>`（幂等，目录已存在时零开销）
   - Read `.cc-bot/runtime/hud-stdin.json`（若存在）— 拼上线通知的「模型 / 上下文」行；不存在就只发标题 + 结尾句
   - Monitor(`node ${CLAUDE_PLUGIN_ROOT}/runtime/poll.js --project <project.root>`, description, persistent, timeout_ms=3600000)
   - Bash: `LARK_CLI_NO_PROXY=1 lark-cli im +messages-send --as bot --chat-id <chat_id> --text "..."` 发上线通知
3. **Monitor 返回 task_id 后**：再发一次 Edit 把 `monitor_task_id` 回写到 state.json

#### 明确**不做**的事（及回滚条件）

- ❌ **不清孤儿进程** — poll.js 的 PID lockfile（三层防御①）启动时自检活进程即 `exit 0`，无需主会话跑 `powershell Get-CimInstance`（慢 2-5s）
  - **回滚条件**：若实战中观察到以下任一症状就恢复主会话清孤儿（见 git blame 本段或 commit `a7f0b4b` 之前版本）：
    - 多个同 project 的 `node runtime/poll.js` 同时在跑（`tasklist` 看到 ≥ 2 个）
    - `poll.emitted` 去重表被重复写入造成同一消息多次推送
    - `BOT_INFO|poll.js|lock-taken-by-pid-*` notification 频繁出现但老 pid 实际已死
- ❌ **不跑 `TaskOutput` 验证 running 状态** — Monitor 启动无 error 即视为成功；若 poll.js 内部报错，下一轮轮询它会 emit `BOT_ERROR|poll.js|...` 到 Monitor stdout，主会话自然收到 notification 再处理
  - **回滚条件**：若观察到 Monitor 启动成功但 poll.js 实际未跑起来（群消息 60s+ 无 NEW_MSG 推送，TaskGet 看 task 状态异常），就加回 `TaskOutput(task_id, block:false)` 验证
- ❌ **不做冗余自检**（lark-cli --version 等）— setup 已验过；如 profile / project.root 真有问题，第一次 lark-cli 调用会报错，届时再处理
  - **回滚条件**：若用户常见报错是"setup 跑过但 lark-cli 后来被卸载/PATH 变了"这种漂移问题，再加回版本自检

#### 异常路径

- Monitor 启动立即 error（task 状态非 running / 非 persistent）→ 主会话报"Monitor 启动失败：{msg}"，让用户排查
- 上线通知 lark-cli 失败 → 主会话报"上线通知发送失败：{msg}"但 Monitor 仍在跑，不回滚 state
- `.cc-bot/profiles/active.json` 缺失 → poll.js 启动时 emit `BOT_ERROR|poll.js|profile-missing` 自动退出，主会话收到 notification 后提示用户先 `/cc-bot:setup`

### 关闭流程

1. 读 state.json 的 `monitor_task_id`，`TaskStop(task_id)` 停 Monitor；poll.js 收到 SIGTERM 后 releaseLock 清 `poll.pid`
2. Edit state.json 设 `paused: true`，清 `monitor_task_id`
3. 发下线通知
4. 验证 `tasklist //FI "imagename eq node.exe"` 里不再有 poll.js 进程；若有残留，`taskkill //F //PID $(cat .cc-bot/runtime/poll.pid) 2>/dev/null; rm -f .cc-bot/runtime/poll.pid`

### 开关通知

- 开启：`cc-bot 已上线` + 模型/上下文进度条（HUD 可用时）+ `发送「帮助」查看支持的操作`
- 关闭：`cc-bot 已下线` + 模型/上下文进度条（HUD 可用时）+ `Bot 进入休眠，群消息将不再响应`

两种通知的 HUD 段格式一致（见 §HUD 的字段来源 / 模型显示规则 / 进度条）。HUD 不可用时都**静默**省略这两行、不贴安装命令到群里。

**主会话 shim 排查提示仅在开启场景触发**（/cc-bot:start 上线通知拼 HUD 段失败、群里显式问"状态/HUD"、开发者主动调试 HUD）。关闭场景 HUD 缺失**不输出**工程提示——用户正在关 bot，此时刷排查信息没意义。

## 运行时文件

| 文件 | 用途 |
|------|------|
| `.cc-bot/profiles/active.json` | 当前激活的项目配置（启动时必读） |
| `.cc-bot/runtime/state.json` | 运行时状态（paused / last_processed_time / pending_confirm / monitor_task_id） |
| `.cc-bot/runtime/poll.js` | API 轮询主进程（Monitor 工具托管） |
| `.cc-bot/runtime/poll.pid` | poll.js 单例锁 pid 文件（启动时写入，退出时清理） |
| `.cc-bot/runtime/poll.emitted` | 已推送 message_id 去重表（最近 200 条） |
| `.cc-bot/runtime/member-cache.json` | 成员缓存（open_id → `{name, role}`） |
| `.cc-bot/runtime/hud-stdin.json` | HUD 数据（cc-hud 写入） |
| `.cc-bot/runtime/events.log` | 历史审计日志（polling 架构下不再写入，仅保留过渡期记录） |

## 角色与权限

### 成员缓存（member-cache.json）

**单一事实源：** `.cc-bot/runtime/member-cache.json`（open_id → `{name, role}`）。角色判定和称呼展示都从这里查。

**处理消息 SOP：**

1. 每条 NEW_MSG 先用 sender 的 open_id 查缓存
2. 命中 → 直接用 `name` + `role`
3. miss → 执行 `lark-cli contact +get-user --as user --user-id <open_id>`，拿到 `name` 立刻 Edit 写回缓存（role 默认 `member`；若 open_id 在 `profile.members.admin_open_ids` 里，role 标 `admin`）
4. 回复用 `name` 称呼，不要用"群成员"、"某位用户"这种模糊指代

**admin 判定：** `role=admin` 必须满足 open_id 同时在 `profile.members.admin_open_ids` 白名单里。缓存为空时新消息按 `role=member` 处理，直到 admin 白名单确认后升级。

回复群消息时用 `member-cache.json` 里的真实 `name` 称呼对方（产品体验例外，不算泄露）。

### 权限矩阵（按 intent 类别，具体键由 profile.intents 自定义）

| 类别 | 权限 | 说明 |
|------|------|------|
| 查询类（进度 / 待办 / 状态 / HUD / 帮助 / 其他只读查询） | public | 读文档、读缓存、读第三方 API |
| 非破坏性的执行类（编译 / 预览 / 跑测试 / 查日志 / 生成二维码 / 页面巡检等） | public | 按 `profile.intents.<key>` 描述执行，无副作用 |
| 修改非生产代码（前端视图 / 本地脚本 / 非关键配置） | public | 编辑 `profile.tech_stack.*` 字段指向的代码路径 |
| 修改关键代码 / 部署类（部署生产 / 推送线上 / 改关键配置） | admin-auto | 按 `profile.intents.<key>` 执行，仅 admin 可用；执行前回纯文本占位，完工报结果 |
| 写类外部资源（数据库写 / 删文件 / 清缓存 / 上传新版本 / 重启服务） | admin-auto | 同上 |
| 破坏性操作（删全量数据 / force-push master / drop database / 删关键文件等） | admin-confirm | 即使 admin 也口头确认一次 |

**权限档位含义：**

- `public` — 所有人可用，无需确认
- `admin-auto` — 仅 `role=admin`，自动执行（跳过 `pending_confirm`），执行前回一句纯文本占位，完工反馈结果。依据 memory `feedback_lark_bot_admin_auto_auth`
- `admin-confirm` — 即使 admin 也需口头确认一次
- `member` 触发 `admin-*` 操作一律拒绝，回"该操作需管理员授权"

## 意图路由

Claude 用自然语言理解判定意图，不做关键词匹配。

### 通用意图（所有 profile 共享）

| 意图 | 触发示例 | 操作 |
|------|---------|------|
| `query_progress` | "进度怎样"、"做到哪了" | 读 `{profile.project.root}/{profile.project.doc_progress}` |
| `query_todo` | "待办"、"还有什么没做" | 从 doc_progress 提取未完成项 |
| `hud` | "状态"、"HUD" | 推送会话状态（见 §HUD） |
| `help` | "帮助"、"能做什么" | 返回**可用**操作列表（按 §帮助动态筛选规则） |
| `bot_switch` | "关闭bot"、"暂停" | **拒绝**，回"开关指令请从 Claude Code 主会话发起" |
| `visual_bug_report` | 文字 + 截图（含 `[Image: img_xxx]`） | 下载图片 → Read → 结合文字判意图 |
| `unknown` | 无法识别 | 回"无法识别该指令，发送「帮助」查看支持的操作" |

### 项目特定意图（从 `profile.intents` 读取）

键名由项目自定义（无预设清单）—— 每个键是一条"自然语言意图 → 具体动作"的映射，Claude 用语义理解匹配群消息意图到 key，再按 `profile.intents.<key>` 的描述执行。

**典型例子**（按需参考，不是强制清单）：
- `deploy`: `用 bash scripts/deploy.sh 部署到生产`
- `run_tests`: `跑 npm test 并汇报通过数 / 失败数`
- `query_logs`: `用 mcp__cloudbase__logs 查最近 20 条错误日志`
- `compile_preview`（小程序项目）: `用 mcp__wechat-devtools__preview 出二维码到 <paths.bot_temp_abs>/preview-qr.png，然后 lark-cli 发图`
- `check_build`（Web / Node 项目）: `tail -50 build.log 看最后构建结果`

profile 未定义的意图 → 回"当前项目未配置该操作，请检查 profile.intents"。

### 帮助动态筛选规则

触发"帮助"意图时，**根据当前 profile 实际配置**动态生成清单，**不列不能用的意图**，避免用户"点了说未配置"的错路：

| 意图类别 | 仅当以下条件满足才列出 |
|---|---|
| `query_progress` / `query_todo` | `profile.project.doc_progress` 非空且文件存在 |
| 任意项目特定意图（`profile.intents.<key>`） | 该 key 对应的 value 是非空字符串（该动作已配置） |
| `hud` / `help` | 永久可用（不依赖 profile 字段） |

生成帮助文本时按 `profile.intents.<key>` 的**描述文字**摘 1 句人话展示（让群成员能看懂做什么），不要机械回显 key 名。

**最小可用清单**（新项目刚 setup，intents 空 + doc_progress 空）只列 `状态 / 帮助` + 一句引导："可在 `.cc-bot/profiles/active.json` 的 intents 字段自定义意图开启更多能力"。

#### 占位符约定

`intents` / `notes` 描述里允许写尖括号占位，Claude 执行时按同名字段替换：

| 占位 | 替换为 |
|------|--------|
| `<project.root>` | `profile.project.root` |
| `<paths.bot_temp_abs>` | `profile.paths.bot_temp_abs`（绝对路径，给 MCP 的 qr_output 等用） |
| `<paths.bot_temp_rel>` | `profile.paths.bot_temp_rel`（相对路径，给 lark-cli `--image` 用） |

目的是让 intents 描述跨项目迁移时不用重写硬编码路径。template.json 已示范字段。

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

### 最高优先级规则 1：处理完立即推进 state.json

**"处理完一条消息"定义：** 已向群发了最终回复（`lark-cli +messages-reply` 成功）。

**发完回复，下一个工具调用必须是 `Edit state.json` 写入 `last_processed_time = {该条 time}`。** 优先级高于：下一条消息处理、部署/编译、任何"顺手再做一步"。

**反例：** Claude 回完消息紧接着跑 compile 或处理下一条 NEW_MSG，中途被 compaction/崩溃/中断。重启后 catch-up 以 `last_processed_time` 为准，把"已回复但 state 未推进"的消息当未处理重新补发，造成重复回复、用户困惑。

**正确节奏：** 回复 → Edit state.json → 再做别的事。每条消息独立推进，绝不批量延迟。

### 最高优先级规则 2：处理前先 fetch 5 条核对（fetch_before_reply）

收到 NEW_MSG 任务通知时，**处理该条前先 `lark-cli im +chat-messages-list --as bot --chat-id <chat_id> --page-size 5 --sort desc`**，对比 `state.json.last_processed_time`，把所有未处理消息按 `create_time` 升序逐条回复 + 推进 state。

**Why：** Monitor 30s 轮询 + poll.emitted 去重，密集多条时可能只推最新一条；system-reminder 也只带一条最新 NEW_MSG。单条 push 处理会漏中间关键消息，严重破坏信任（2026-04-20 实战经验，依据 memory `feedback_fetch_before_reply`）。

**特别触发 fetch 10 条：**
- 用户情绪激动（连发"？？？"、质疑"你收到了吗"）
- 用户连续两次 ACK 无回应 / 质疑
- 主会话刚从长工具链回来（Edit/Bash/Agent 连续 ≥3 min）

宁可多 fetch（成本低），不要漏看（信任成本高）。

### 完整流程

0. **fetch 核对**（见上，最高优先级 2）
1. **解析**：从 `|` 分隔字符串提取字段
2. **角色判定**：查 member-cache.json，miss 则 `contact +get-user` 回填（admin 要和 profile.members.admin_open_ids 对齐）
3. **待确认检查**：读 state.json 的 `pending_confirm`（未超时）：
   - "Y"/"y"/"是"/"确认" → 执行
   - 其他 → 取消
   - admin 永久授权直接跳过 `pending_confirm`
4. **图片预处理**（content 含 `[Image: img_xxx]`）：逐个下载 + Read
5. **意图识别 + 执行**：通用意图按 §意图路由，项目特定查 profile.intents
   - admin 触发危险操作 → 直接执行，不写 `pending_confirm`
   - member 触发"仅管理员"操作 → 拒绝
   - 其他危险操作的非 admin → 写 `pending_confirm`（15 min 超时）
   - `lark-cli im +messages-reply --as bot --message-id <msg_id>` 回复（用 `{name}` 称呼）
6. **推进 state.json**：Edit `last_processed_time = time`

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

一次轮次收到多条 NEW_MSG（堆积）时：

- **逐条回复不合并**：每条独立判断意图、独立 `+messages-reply`，禁止只回最新一条或合并总结
- **逐条推进 state.json**：每处理完一条立刻 Edit，不要批量更新。否则中途压缩/崩溃会永久丢未回复的消息
- **中途 fetch 5 条兜底**：每条处理前按「最高优先级规则 2」重新 fetch，确认 Monitor 没漏推中间条
- **按 create_time 升序回复**（不按 Monitor 到达顺序）

### ACK 消息立刻响应（ack_msg_action）

群里收到 `ACK`（"可以"、"继续"、"好的"、"OK"、"嗯"、"是的"等）类消息时：

1. **立刻推进 state.json**
2. **立刻回一条短文本**：「好，开始 X」或「开始 batch 2」或「收到，改 Y 中」（≤15 字）
3. **马上动手干**，不要分心做别的

**Why：** ACK = 绿灯不是红灯。在多批次任务（"分 3 批做"、"先 A 再 B"）里，每一次 ACK 都是下一批的启动信号。沉默会被严重不满——2026-04-20 实战复盘：负责人回「可以，继续」被误当成"无需处理"，18 min 后遭严厉批评。依据 memory `feedback_ack_msg_action`。

即便 ACK 只是单字回复（"嗯"、"好"），也要立刻响应 + 回报进度。agent 工作返回时别忘了切回来处理群消息。

### Monitor 异常时 API 兜底

polling 架构下，Monitor 工具托管的 `poll.js` 是主回路，每 30s 主动 HTTP 轮询拉消息 → emit NEW_MSG 到 stdout → notification 到主会话。**通常情况下 Monitor push 可靠**（不再有老架构的"Bash background stdout→pipe 压缩断开"问题）。

但以下三种场景仍需 API 兜底（直接调 `lark-cli im +chat-messages-list` 对比 `state.json.last_processed_time`，不走 poll.js / poll.emitted 通道）：

1. **Monitor task 挂掉**：`TaskGet(task_id)` 返回 `Task not found` / `failed` / `completed`（非 persistent 内预期状态）
2. **poll.js 连续失败告警**：主会话收到 `BOT_ERROR|poll.js|lark-cli 连续失败 N 次` notification
3. **用户主动问"群里有消息吗 / 新消息吗 / hello?"**：不凭记忆回答，立即 fetch 核对（和「最高优先级规则 2」的 fetch_before_reply 一致）

老架构下的"每 turn 主动 tail events.log" 已**废弃**——events.log 在 polling 架构下不再是事件源，仅保留为过渡期审计日志。`poll.emitted` 是 poll.js 内部去重表，**绝不要手动清空**（会导致历史消息被当新消息重推刷屏）。

**Monitor push 与 API 兜底结果冲突时以 API 为准。**

## 运行时节奏（长会话反崩溃）

### Agent 优先策略（默认思路）

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
- 工程改动（skill、member-cache、monitor.sh）可合进 fix/feat commit，但不上群
- push 失败不重试，发群"push 失败：{错误}，需要你检查网络/凭据"

## 回复格式

- 简洁工具风，只返回结果
- 图片用 `lark-cli im +messages-send --as bot --chat-id <群ID> --image <相对路径>`

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
- 允许温和的单字符情绪标记：`🙏`（致歉）、`✅`（完成）— 一条回复最多 1 个，紧贴动作词（"修好了 🙏"），不做装饰
- 禁用彩虹式 emoji、拟人语气（"小助手正在帮您..."）、感叹号堆砌

**与简洁原则的边界**

- 情绪价值 ≠ 啰嗦。一句"抱歉，是我漏了"就够了
- 动作**永远比情绪重要**：承认 → 立刻开工 → 做完报结果
- 对方如果是冷静提问（非情绪），**不要硬加道歉和 🙏**，正常工具风即可

### 工程性改动不发群（重要）

**SKILL.md / 成员缓存 / 监听规则 / bot 自身行为调整 / profile 改动等工程改动，不发群通知。只有业务产出（bug 修复、功能上线、新二维码、提审版本）才发群。**

反例：修复 bot skill、调整占位规则、更新 member-cache、切换 profile 的"已完成"消息都不发群。开发人员在主会话直接确认即可。

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

下载完立即 `Read <绝对路径>`（Read 接受绝对路径），结合文字理解意图后回复。多图依次 download + Read 再综合判断。

### Shell 安全规范（Windows Git Bash）

**禁止：**
- `$'...'` 语法 — Windows bash 支持不稳定，`$'` 会泄漏为文本
- 单引号内嵌中文或特殊字符 — 终端编码不一致
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

**群回复**（简洁，不往群里贴命令，群成员看不懂）：
```
HUD 数据暂不可用
```

**同时在主会话里**向开发者输出一条工程提示，**仅以下场景触发**：
- `/cc-bot:start` 上线通知拼 HUD 段失败
- 群里显式问「状态/HUD」
- 开发者主动调试 HUD

**不触发的场景：** `/cc-bot:stop` 下线通知（用户正在关 bot，此时刷排查信息没意义）。

HUD 数据由 cc-bot 自己的 statusline shim（`runtime/statusline.js`）落盘。检测 shim 是否已注册到 `~/.claude/settings.json`：

```bash
grep -q 'cc-bot.*statusline\.js\|statusline\.js.*cc-bot' ~/.claude/settings.json 2>/dev/null && echo registered || echo unregistered
```

**未注册（`unregistered`）**：
```
ℹ️ cc-bot statusline shim 未注册到 ~/.claude/settings.json。重跑 /cc-bot:setup（步骤 7 会自动注册），然后重开 CC 会话；下一次 statusline tick（任意工具调用后）即可生成 hud-stdin.json。
```

**已注册但未触发（`registered`，但 hud-stdin.json 仍缺失/空）**：
```
ℹ️ statusline shim 已注册但 hud-stdin.json 未生成。可能原因：
  1. CC 刚启动未触发过 statusline tick → 随便执行一次工具调用后再看
  2. CC 版本 / shim 路径错位 → 检查 ~/.claude/settings.json 的 statusLine.command，确认 ${CLAUDE_PLUGIN_ROOT}/runtime/statusline.js 解析到真实路径
  3. shim 异常静默失败 → 在终端手动跑 `echo '{}' | node <插件路径>/runtime/statusline.js` 观察是否报错
```

### cc-hud 与 statusline 的关系

cc-hud 是独立的 statusline **渲染器**（stdin JSON → stdout 渲染结果），它**不写文件**。cc-bot 的 shim 包了一层：先落盘 stdin JSON 给 cc-bot 用，再透传给 cc-hud 渲染状态栏。两者互不冲突、可共存，装不装 cc-hud 都不影响 cc-bot 的 HUD 群消息功能（只影响状态栏是否美观）。

这两个工程提示都按 §工程性改动不发群 规则**只在主会话展示，不进群**。

### HUD 可用时的群消息格式

群里发"状态"或"HUD"触发。读 `hud-stdin.json`：

```
Claude Code HUD
CC: v2.1.112
模型: Opus 4.7 (1M context)
上下文: ██░░░░░░░░ 13%  (130K / 1M)
5h 额度: ██░░░░░░░░ 18% (剩 3.2h)
7d 额度: ░░░░░░░░░░ 2%  (剩 6.9d)
```

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
- Monitor 退出 → 重新启动
- `.cc-bot/profiles/active.json` 缺失 → 回"未配置 profile，请先复制 template.json 或切换项目"
