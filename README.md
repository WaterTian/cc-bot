# cc-bot

**Claude Code 插件** — 把任意 IM 群变成 AI 项目助手。飞书（Lark）起步，IM 可扩展。

在群里发自然语言指令，bot 帮你：

- **查询** — 项目进度、待办、数据统计、测试状态、后台地址
- **编译预览** — 小程序项目一键出二维码
- **页面巡检** — 批量跳转页面，汇总异常
- **修复 bug** — 描述 bug + 截图，bot 定位 + 改代码 + 出新码
- **部署** — 云函数、管理后台一键部署（admin 权限）
- **数据库操作** — 读写 NoSQL、查日志（admin 权限）

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
       "root": "D:\\Path\\To\\Project",
       "doc_progress": "docs/progress.md"
     },
     "members": { "admin_open_ids": ["ou_xxxx"] },
     "intents": { ... }
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
