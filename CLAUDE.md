# cc-bot — Claude Code 插件开发者文档

本仓库是 **cc-bot Claude Code 插件** 的源码仓库。cc-bot 本身**不自举跑 bot**，测试/自用在独立项目目录（例 `D:\Projects\cc-bot-test\`）进行，通过 `claude --plugin-dir D:/Projects/cc-bot` 本地加载。

## 仓库结构

```
cc-bot/
├── .claude-plugin/
│   ├── plugin.json              # 插件元数据（name / version / commands / skills）
│   └── marketplace.json         # marketplace 注册（发布时用，TODO）
├── package.json                 # npm 元数据
├── adapters/                    # IM 抽象层
│   ├── base.js                  # IMAdapter 基类（接口定义）
│   └── lark.js                  # 飞书实现（包 lark-cli）
├── runtime/
│   └── poll.js                  # 消息轮询主进程（Monitor 托管）— 必须接 --project <abs>
├── skills/
│   └── lark-bot/
│       └── SKILL.md             # 飞书版 bot 行为规范
├── commands/                    # slash 命令（由 plugin.json 注册）
│   ├── setup.md                 # /cc-bot:setup
│   ├── start.md / stop.md       # /cc-bot:start / /cc-bot:stop
│   ├── new-profile.md           # /cc-bot:new-profile <name>
│   └── switch.md                # /cc-bot:switch <name>
├── templates/
│   └── template.json            # profile 模板，setup 时 copy 到目标项目 .cc-bot/profiles/
├── .claude/
│   ├── settings.json            # 开发本仓库用的 permission / MCP 开关（进库）
│   └── settings.local.json      # 本机覆盖，含绝对路径（gitignore）
├── CLAUDE.md                    # 本文件
└── README.md                    # 对外分发文档
```

## 架构要点

- **IMAdapter 抽象**：`adapters/base.js` 定义接口（`listRecentMessages` / `sendText` / `sendImage` / `downloadResource` / `getUser`）。当前只有 `adapters/lark.js`。扩展新 IM 时新增 adapter 文件 + `runtime/poll.js` 的 factory 分支 + profile `im.type` 即可。
- **IM 无关定位**：cc-bot 是 IM 无关的 Claude Code 群 bot 插件，飞书 = 当前默认实现；见 memory `feedback_im_agnostic_design`。
- **每项目独立 `.cc-bot/`**：使用 cc-bot 的项目在自己根目录下建 `.cc-bot/profiles/` + `.cc-bot/runtime/`，profile 和运行时状态都跟项目走，多项目互不污染。
- **poll.js 无项目假设**：启动参数 `--project <abs-path>`，所有路径基于此。`${CLAUDE_PLUGIN_ROOT}` 由 Claude Code 在插件安装后注入。
- **三层防御**（详见 SKILL §poll.js 三层防御）：PID lockfile / stdout EPIPE / state 未来值自愈。2026-04-20 polling 架构三坑对策，不可删。

## 本地开发 / 测试流程

1. **建测试项目**：`mkdir D:\Projects\cc-bot-test`
2. **加载插件**：在测试项目下启 `claude --plugin-dir D:/Projects/cc-bot`
3. **初始化**：在测试项目 Claude Code 会话里发 `/cc-bot:setup` → 生成 `.cc-bot/` 骨架 + 拷贝 template
4. **配置 profile**：编辑测试项目的 `.cc-bot/profiles/active.json`（填测试群 `im.bot_app_id` / `chat_id`）
5. **开启 bot**：`/cc-bot:start`，验证 Monitor 正常启动 + 群消息能收到 NEW_MSG
6. **关闭 bot**：`/cc-bot:stop`
7. **迭代**：修 cc-bot 源码后在测试项目会话里 `/reload-plugins` 热加载

`${CLAUDE_PLUGIN_ROOT}` 在 `--plugin-dir` 下解析为 `D:/Projects/cc-bot`，与发布后从 marketplace 装的路径差异**仅在缓存位置**，业务行为一致。

## 常用指令（在使用 cc-bot 的目标项目里）

| 指令 | 效果 |
|------|------|
| `/cc-bot:setup` | 在当前项目建 `.cc-bot/` 骨架 + 拷贝 template |
| `/cc-bot:start` 或 `开bot` / `开启bot` / `打开bot` | 启 Monitor、发上线通知 |
| `/cc-bot:stop` 或 `关bot` / `关闭bot` / `停bot` | 停 Monitor、发下线通知 |
| `/cc-bot:new-profile <name>` | 从 template 生成新 profile |
| `/cc-bot:switch <name>` | 切换激活 profile |

## 关键约束

- **核心诉求：稳定 > 自愈速度 > 功能丰富**。改动默认选保守方案，自愈动作需可回滚
- **禁止跨项目杀 lark-cli / node 全局进程**。清 poll.js 孤儿时必须按 `--project <root>` 精确匹配
- **工具本身**的代码（SKILL.md / poll.js / adapter / commands / templates）改动不发群
- profile 切换不发群通知（工程改动）
- 真名脱敏规则见 memory `feedback_memory_privacy`
- admin 永久授权见 memory `feedback_lark_bot_admin_auto_auth`

## Git 提交隐私防护（开发本仓库必装）

仓库带了 pre-commit 扫描脚本，阻止真实飞书 ID / 黑名单真名 / secret 误入 commit。新 clone 后一次性装：

```bash
# 1. 启用 hook 路径
git config core.hooksPath scripts/hooks

# 2. 复制脚本到 hooks 目录（Windows 无 symlink 用复制，Linux/macOS 可 ln -sf）
mkdir -p scripts/hooks
cp scripts/pre-commit-scan.sh scripts/hooks/pre-commit
chmod +x scripts/hooks/pre-commit scripts/pre-commit-scan.sh

# 3. 建本地真名黑名单（gitignore，不进库）
cp scripts/blocklist.txt.example scripts/blocklist.txt
# 编辑 scripts/blocklist.txt 一行一个真名
```

扫描规则：飞书真实 ID (`cli_/ou_/oc_/om_` + 14 位以上 hex) + blocklist 子串 + `app_secret/api_key/bearer token` 正则。命中即 `exit 1`。确需绕过用 `git commit --no-verify`（谨慎）。

## 发版流程（维护者）

一键 bump 脚本 `scripts/release.js`：原子更新 `plugin.json` + `marketplace.json` + `package.json` 三处版本号、prepend CHANGELOG.md、commit、tag。

```bash
npm run release patch          # 0.1.1 → 0.1.2（默认不推，手工 git push）
npm run release patch --push   # 一把梭：写文件 + commit + tag + push main + push tag
npm run release minor --dry    # 预览，不写文件（看 changelog entry 合理再执行）
npm run release 0.2.0          # 指定具体版本号
```

preflight 校验：必须在 main 分支、工作区干净、目标 tag 不存在。

发版顺序：① 业务/功能性 commit 先做完、全部推上 main → ② 跑 `npm run release` bump → ③ 使用 cc-bot 的项目按 README §Updating 跑 3 条命令拉新版。

## 先决条件（使用 cc-bot 的项目需要）

- `lark-cli` 已全局安装并完成 `auth login`（bot + user 身份）
- Claude Code 已安装
- Windows 用 Git Bash（adapter 底层借 bash shell 传 argv；不能用 PowerShell/cmd）
- 按 profile.intents 需要，安装对应 MCP（如 wechat-devtools / chrome-devtools 等，视项目定）

## 相关 memory

通用 memory 在 `~/.claude/projects/D--Projects-cc-bot/memory/`，自动加载。
