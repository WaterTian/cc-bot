# cc-bot

**Claude Code 插件** — 把任意 IM 群变成 AI 项目助手。飞书（Lark）起步，IM 可扩展。

在群里发自然语言指令，bot 帮你（意图由你在 `profile.intents` 自定义，下面是常见类型）：

- **通用查询** — 项目进度、待办事项、HUD（模型 / 上下文 / 额度）
- **执行只读动作** — 跑测试、查日志、构建预览、页面巡检、生成二维码等（按项目自定义）
- **修复 bug** — 成员描述 bug + 截图，bot 定位 + 改代码（profile 配置的代码路径内）
- **部署 / 写操作** — 部署到生产、写数据库、推送线上（admin 权限，自动通过）
- **破坏性操作** — drop database / force-push master / 批量删数据等（admin 也要口头确认）

适配各类项目：Web / 小程序 / Node 服务 / Python 数据管道 / 移动端等。只要能写脚本的事，`profile.intents` 都能定义。

## 安装

### 方式 1：Claude Code 插件市场（推荐，发布后）

```
/plugin marketplace add WaterTian/cc-bot
/plugin install cc-bot@WaterTian-cc-bot
```

### 方式 2：源码（开发或早期尝鲜）

```bash
git clone https://github.com/WaterTian/cc-bot
cd cc-bot
# 在当前项目 Claude Code 会话里跑
/cc-bot:setup
```

## 首次配置

1. **在目标项目**打开 Claude Code，发 `/cc-bot:setup`
   - 会建 `.cc-bot/profiles/` 和 `.cc-bot/runtime/`、复制 template、更新 `.gitignore`
2. **编辑** `.cc-bot/profiles/active.json`：
   ```json
   {
     "im": {
       "type": "lark",
       "bot_app_id": "cli_xxxxxxxxxxxx",
       "chat_id": "oc_xxxxxxxxxxxx"
     },
     "project": {
       "root": "D:/Path/To/Project",
       "doc_progress": ""
     },
     "members": { "admin_open_ids": ["ou_xxxx"] },
     "intents": {
       // 按项目自定义意图 → 动作描述，例：
       // "deploy": "bash scripts/deploy.sh 部署到生产",
       // "run_tests": "跑 npm test 并汇报通过数 / 失败数"
     }
   }
   ```
3. **发** `/cc-bot:start` 启动 bot（或在主会话直接说「开bot」）。

## 前置依赖

- **Claude Code**（本插件依赖 Skill / Monitor / TaskStop 工具）
- **Node.js ≥ 18**
- **飞书 CLI**：`npm i -g @larksuite/cli`，然后 `lark-cli auth login`（bot + user 身份）
- **Git Bash**（Windows 必需 — poll.js adapter 用 bash 传 argv 避 cmd.exe 的坑）

## 命令

| 命令 | 作用 |
|------|------|
| `/cc-bot:setup` | 在当前项目建 `.cc-bot/` 骨架（首次用） |
| `/cc-bot:start` | 启动 bot（开 Monitor，发上线通知） |
| `/cc-bot:stop` | 关闭 bot（停 Monitor，发下线通知） |
| `/cc-bot:new-profile <name>` | 从 template 生成新 profile |
| `/cc-bot:switch <name>` | 切换激活 profile |

也可以直接在主会话发自然语言：`开bot` / `关bot` / `切换到 xxx 项目`。

## 架构

```
主会话 ── Monitor(persistent) ── node poll.js ── 每 30s IMAdapter.listRecentMessages()
                                              ├─ state.last_processed_time + poll.emitted 去重
                                              └─ stdout: NEW_MSG|msg_id|sender|content|ts
                                                         ↓ Monitor → notification
                                                   主会话 → 意图判定 → adapter.sendText
```

**HTTP 短连接** 替代 WebSocket — vpn 代理下 WS 会被静默断流，HTTP 稳定。响应延迟 ≤ 30s。

**三层防御**：PID lockfile 单例 / stdout EPIPE 自杀 / state 未来值自愈。

## 扩展新 IM

当前只实现了飞书 adapter。加企业微信 / 钉钉 / Slack / Discord 的流程：

1. 在 `adapters/` 新增 `<im>.js`，继承 `IMAdapter` 实现全部方法
2. 在 `runtime/poll.js` 的 adapter factory 加分支：`if (im.type === '<im>') ...`
3. profile 的 `im.type` 设为新 IM 名
4. 在 `skills/lark-bot/SKILL.md` 类似地加 `<im>-bot/SKILL.md`（或扩展现有 SKILL）

adapter 接口定义见 `adapters/base.js`。

## 项目无关性

| 模块 | 位置 | 跟谁走 |
|------|------|--------|
| SKILL / adapter / poll.js / commands | `${CLAUDE_PLUGIN_ROOT}/` | 插件版本 |
| 群 ID / 项目根 / 成员 / 意图映射 | `<project>/.cc-bot/profiles/active.json` | 每项目 |
| state / 缓存 / pid / 去重 | `<project>/.cc-bot/runtime/` | 每项目（gitignore） |

一套插件，多个项目同时用互不打架。

## License

MIT © Water
