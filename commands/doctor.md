---
name: doctor
description: Health check for cc-bot in current project — version drift, profile validity, runtime state, zombie permissions, statusline shim, lark-cli auth
---

Run a read-only health check of cc-bot for the **current project**. **No file is modified** — fixes are only suggested.

Execute checks in parallel where possible. Collect results, then print one unified markdown report at the end. Each line uses `✓` (pass) / `⚠` (drift / needs attention) / `✗` (broken / missing) / `ℹ` (informational).

---

## Checks

### 1. Version

- **Installed version**: Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` → `version`
- **Active scopes**: Read `~/.claude/plugins/installed_plugins.json` → list every `cc-bot@cc-bot` entry (`scope` / `version` / `projectPath` / `installPath`). Mark:
  - `user` scope missing → ✗ not installed globally
  - `project` scope for a **different** project than current → ℹ 与当前项目无关，保留
  - `project` scope for current project but `version` < `user` scope version → ⚠ stale project pin
- **Latest release on GitHub** (best-effort, 3s timeout): `curl -sfL --max-time 3 https://api.github.com/repos/WaterTian/cc-bot/releases/latest | grep '"tag_name"' | head -1`
  - If latest > installed → ⚠ 提示升级：`/plugin marketplace update cc-bot && /plugin update cc-bot@cc-bot && /reload-plugins`
  - curl 失败 / 无 release → ℹ 跳过

### 2. Profile (`.cc-bot/profiles/active.json`)

- File exists? ✗ if missing → suggest `/cc-bot:setup`
- Field validity (for lark profiles):
  - `im.type` in `['lark']` — 其他值 → ✗ unsupported adapter
  - `im.bot_app_id` matches `^cli_[a-z0-9]+$` and **not** `cli_xxxxxxxxxxxx` — ✗ if still placeholder
  - `im.chat_id` starts with `oc_` and length > 20 — ✗ if placeholder
  - `project.root` is an existing directory — ✗ if path 不存在 / 仍是 `D:/Path/To/Project`
  - `paths.bot_temp_abs` / `bot_temp_rel` both present — ⚠ if missing
  - `members.admin_open_ids` non-empty array — ⚠ if `[]`（ admin 权限矩阵将全部回退到 member）

### 3. Runtime (`.cc-bot/runtime/`)

- `state.json` exists? ✗ if missing → `/cc-bot:setup` 或手工创建
- Read `state.json.monitor_task_id`:
  - null / empty → ℹ bot 当前未启动
  - 非空 → `TaskGet(id)` → status `running` ✓ / `failed` / `completed` ⚠ 提示跑 `/cc-bot:start` 或见 SKILL §Monitor 异常重启
- `poll.pid` exists?
  - 不存在 → ✓（未在跑，正常态）
  - 存在 → 读出 pid，用 `tasklist //FI "pid eq <pid>"` (Windows) 或 `ps -p <pid>` (unix) 验证
    - 进程活 + state.monitor_task_id 非空 → ✓
    - 进程死 → ⚠ 陈旧 pid 文件，建议 `rm .cc-bot/runtime/poll.pid`
- `state.last_processed_time`：若是数字且距今 > 24h 且 `paused=false` → ⚠ 提示 bot 可能长期未收到消息

### 4. Zombie permissions (settings.local.json)

- Read `<project-root>/.claude/settings.local.json`（不存在跳过）
- 扫 `permissions.allow[]` 内含 `cache/cc-bot/cc-bot/<具体数字版本号>/` 硬编码的规则
- 对每条命中：
  - 提取规则里嵌的版本号 vs 当前 cc-bot installed version
  - 版本相同 → ℹ 规则匹配当前版本，仍有效（可选择升级为通配以防下次升级再弹）
  - 版本不同 → ⚠ 僵尸规则，列出完整 rule 字符串 + 推荐替换为通配：
    ```
    Bash(node */cache/cc-bot/cc-bot/*/runtime/poll.js --project *)
    ```

### 5. Statusline shim (`~/.claude/settings.json`)

- Read `~/.claude/settings.json`。不存在 → ⚠ 未注册
- `statusLine.command` 含 `cc-bot` 且含 `statusline.js` → ✓
- 含 `cc-hud` 不含 cc-bot → ⚠ shim 未经 cc-bot 包装，`hud-stdin.json` 不会落盘
- 其他值 / 缺失 → ⚠ 建议重跑 `/cc-bot:setup`（step 8 会幂等注册）
- ✓ 时进一步查 `.cc-bot/runtime/hud-stdin.json` 是否存在：
  - 不存在 → ⚠ statusline tick 尚未触发过，随便跑一次 tool 后再查
  - 存在但 JSON 解析失败 → ⚠ 文件损坏

### 6. lark-cli

- `lark-cli --version` 成功？✗ if not found → `npm i -g @larksuite/cli`
- `lark-cli auth list`（默认输出 JSON，不要加 `--format json`）返回非空 `[]`？
  - 空 → ✗ 未登录，`lark-cli auth login`
  - 非空 → ✓，列出 appId / userName

### 7. cc-hud (optional)

- `~/.claude/plugins/installed_plugins.json` 含 `cc-hud@` key → ℹ 已装 `<version>`
- 未装 → ℹ 未装（不影响 cc-bot 群 HUD 意图，仅影响状态栏视觉；可选装 `/plugin marketplace add WaterTian/cc-hud` + `/plugin install cc-hud@WaterTian-cc-hud`）

---

## Output format

打印一份汇总 markdown 块：

```
cc-bot doctor — <project.display_name 或 project-root basename>
安装版本 <X.Y.Z> · Claude Code <CC version from hud-stdin 若有> · <当前时间>

## 版本
<✓ / ⚠ / ✗ 行>

## 作用域
<逐条作用域 + 版本>

## Profile
<字段校验结果>

## 运行时
<Monitor / poll.pid / state.last_processed_time>

## 权限扫描
<零僵尸则 ✓ "未发现硬编码旧版本路径"；否则列出僵尸条目>

## Statusline
<shim 注册 / hud-stdin 生成状态>

## lark-cli
<版本 + auth 状态>

## cc-hud（可选）
<已装 / 未装>

---

## 建议动作（按优先级）

1. <最紧迫的 fix，例 "profile im.chat_id 仍是占位符 → 重跑 /cc-bot:setup"> 
2. <次要 fix，例 "settings.local.json 有 0.1.0 僵尸规则 → 替换为通配"> 
3. ...

无建议时写 "✓ 一切正常"。
```

**重要：不要擅自动手改任何文件**。doctor 只报告，由用户决定是否执行建议动作。若用户在 report 后说 "帮我清"/"自动修" 再逐项执行。
