# cc-bot

**Claude Code 插件** — 把任意 IM 群变成 AI 项目助手。飞书（Lark）起步，IM 可扩展。

在群里发自然语言指令，bot 帮你（意图由你在 `profile.intents` 自定义，下面是常见类型）：

- **通用查询** — 项目进度、待办事项、HUD（模型 / 上下文 / 额度）
- **执行只读动作** — 跑测试、查日志、构建预览、页面巡检、生成二维码等（按项目自定义）
- **修复 bug** — 成员描述 bug + 截图，bot 定位 + 改代码（profile 配置的代码路径内）
- **部署 / 写操作** — 部署到生产、写数据库、推送线上（admin 权限，自动通过）
- **破坏性操作** — drop database / force-push master / 批量删数据等（admin 也要口头确认）

适配各类项目：Web / 小程序 / Node 服务 / Python 数据管道 / 移动端等。只要能写脚本的事，`profile.intents` 都能定义。

## Auto-install (for Claude Code AI agents)

```
Step 1: /plugin marketplace add WaterTian/cc-bot
Step 2: /plugin install cc-bot@WaterTian-cc-bot
Step 3: /cc-bot:setup
Step 4: Restart Claude Code
```

## 安装

### 方式 1：插件市场（推荐，发布后）

```
/plugin marketplace add WaterTian/cc-bot
/plugin install cc-bot@WaterTian-cc-bot
```

### 方式 2：本地源码（开发 / 早期尝鲜）

```bash
git clone https://github.com/WaterTian/cc-bot
# 在目标项目下启 Claude Code：
claude --plugin-dir <绝对路径>/cc-bot
```

## 使用

### 首次配置（交互式向导）

在目标项目 Claude Code 会话里发 **`/cc-bot:setup`**，向导会：

1. 检测 lark-cli（未装自动 `npm i -g @larksuite/cli`）
2. 飞书开放平台建应用 + scope 清单 + 浏览器 OAuth 登录（卡片式确认）
3. 列出 bot 所在群让你选，或一键新建群（AskUserQuestion 卡片）
4. 自动探测 `bot_app_id` / `admin_open_id`，写入 `.cc-bot/profiles/active.json`
5. 注册 statusline shim（接管 `~/.claude/settings.json` 的 statusLine，落盘 HUD 数据，并 tee cc-hud 渲染状态栏，若装了 cc-hud）
6. 建 `.cc-bot/runtime/state.json` + `member-cache.json` + `.gitignore`

配完发 **`/cc-bot:start`** 或主会话说「开bot」即可。

### 命令族

| 命令 | 作用 |
|------|------|
| `/cc-bot:setup` | 首次配置（交互式向导，幂等重入） |
| `/cc-bot:start` 或 `开bot` / `启动bot` | 启 Monitor + 发上线通知 |
| `/cc-bot:stop` 或 `关bot` / `停bot` | 停 Monitor + 发下线通知 |
| `/cc-bot:new-profile <name>` | 从 template 生成新 profile |
| `/cc-bot:switch <name>` | 切换激活 profile（自动先关正在跑的 bot） |

主会话也接受自然语言触发（"开bot"、"关bot"、"切换到 xxx"），经意图识别走对应 slash。

## 前置依赖

- **Claude Code**（用到 Skill / Monitor / TaskStop / AskUserQuestion 等工具）
- **飞书 CLI** — `npm i -g @larksuite/cli` + `lark-cli auth login`（setup 会引导做这两步）
- **Git Bash**（Windows）— poll.js adapter 用 bash shell 传 argv 规避 cmd.exe 的坑
- 可选：**cc-hud** — 搭配显示状态栏（`/plugin install cc-hud@WaterTian-cc-hud` + `/cc-hud:setup`）

## 架构

```
主会话 ── Monitor(persistent) ── node poll.js ── 每 30s IMAdapter.listRecentMessages()
                                              ├─ state.last_processed_time + poll.emitted 去重
                                              └─ stdout: NEW_MSG|... → 主会话 → adapter.sendText

statusline shim ── 接管 CC statusLine ── 落盘 .cc-bot/runtime/hud-stdin.json
                                      └─ tee cc-hud（可选）渲染状态栏
```

**HTTP 短连接** 替代 WebSocket（vpn 代理下 WS 易静默断流，HTTP 稳定）。**三层防御**：PID lockfile 单例 / stdout EPIPE 自杀 / state 未来值自愈。

## 项目无关性

| 模块 | 位置 | 跟谁走 |
|------|------|--------|
| SKILL / adapter / poll.js / commands / templates | `${CLAUDE_PLUGIN_ROOT}/` | 插件版本 |
| 群 ID / 项目根 / 成员 / 意图映射 | `<project>/.cc-bot/profiles/active.json` | 每项目（gitignore） |
| state / 缓存 / pid / 去重 / bot_temp | `<project>/.cc-bot/runtime/` + `.cc-bot/bot_temp/` | 每项目（gitignore） |

一套插件，多项目并行使用互不污染。

## 扩展新 IM

当前仅飞书 adapter。加企业微信 / 钉钉 / Slack / Discord 的流程：

1. `adapters/<im>.js` 继承 `IMAdapter`（见 `adapters/base.js`）实现 `listRecentMessages / sendText / sendImage / downloadResource / getUser`
2. `runtime/poll.js` 的 adapter factory 加 `if (im.type === '<im>')` 分支
3. profile 的 `im.type` 填对应 IM 名
4. 新增 `skills/<im>-bot/SKILL.md` 或复用现有

## 隐私防护

仓库自带 pre-commit 扫描脚本，阻止真实 IM ID / 真名 / api secret 误入 commit。开发者本地一次性装（见 CLAUDE.md §Git 提交隐私防护）。

## License

MIT © Water
