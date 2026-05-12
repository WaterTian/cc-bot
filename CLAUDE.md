# cc-bot — Claude Code 插件开发者文档

本仓库是 **cc-bot Claude Code 插件** 的源码仓库。cc-bot 本身**不自举跑 bot**，测试/自用在独立项目目录（例 `D:\Projects\cc-bot-test\`）进行，通过 `claude --plugin-dir D:/Projects/cc-bot` 本地加载。

## 仓库结构

```
cc-bot/
├── .claude-plugin/
│   ├── plugin.json              # 插件元数据（name / version / commands / skills）
│   └── marketplace.json         # marketplace 入口注册（`/plugin marketplace add WaterTian/cc-bot` 读此文件）
├── package.json                 # npm 元数据
├── adapters/                    # IM 抽象层
│   ├── base.js                  # IMAdapter 基类（接口定义，含 push 模式 startListening/stopListening）
│   ├── lark.js                  # 飞书实现（包 lark-cli，polling 模式）
│   └── slack.js                 # Slack 实现（@slack/socket-mode + @slack/web-api，push 模式 v0.1.12+）
├── runtime/
│   ├── poll.js                  # 消息主进程（Monitor 托管）— 必须接 --project <abs>；IM_MODE='polling'(lark) / 'push'(slack)
│   ├── slack-send.js            # 跨平台 Slack Web API helper（v0.1.12+ 规避 Win curl GBK 乱码 + token 暴露）
│   ├── statusline.js            # CC statusLine shim — 把 HUD stdin 落盘到 .cc-bot/runtime/hud-stdin.json
│   ├── main-busy.js             # CC UserPromptSubmit/Stop hook — 写/删 .cc-bot/runtime/main-busy.lock（v0.1.6+）
│   └── check-image-size.js      # 图片维度门禁（v0.1.11+ 防 Claude API 2000px dimension_limit 阻塞）
├── skills/
│   └── lark-bot/
│       └── SKILL.md             # bot 行为规范（命名遗留，实际服务 lark + slack 两端）
├── commands/                    # slash 命令（由 plugin.json 注册）
│   ├── setup.md                 # /cc-bot:setup（v0.1.12+ Stage 0 选 IM 后按 lark / slack 分流）
│   ├── start.md / stop.md       # /cc-bot:start / /cc-bot:stop（按 im.type 选发送方式 + locale 双语模板）
│   ├── new-profile.md           # /cc-bot:new-profile <name>
│   ├── switch.md                # /cc-bot:switch <name>
│   └── doctor.md                # /cc-bot:doctor（v0.1.2+ 健康检查）
├── templates/
│   ├── template.json            # profile 模板，setup 时 copy 到目标项目 .cc-bot/profiles/（含 im.locale + _slack_example）
│   └── slack-manifest.yaml      # Slack App manifest 模板（v0.1.12+，9 scopes + Socket Mode + 3 event_subscriptions）
├── .claude/
│   ├── settings.json            # 开发本仓库用的 permission / MCP 开关（进库）
│   └── settings.local.json      # 本机覆盖，含绝对路径（gitignore）
├── CLAUDE.md                    # 本文件
└── README.md                    # 对外分发文档
```

## 架构要点

- **IMAdapter 抽象**：`adapters/base.js` 定义接口（`listRecentMessages` / `sendText` / `sendImage` / `downloadResource` / `getUser`，以及 push 模式扩展的 `startListening` / `stopListening`）。已有实现：`adapters/lark.js`（polling）+ `adapters/slack.js`（push，v0.1.12+）。扩展新 IM 时新增 adapter 文件 + `runtime/poll.js` 的 factory 分支 + profile `im.type` 即可。
- **两种工作模式**：`IM_MODE = 'polling'`（lark：HTTP 30s tick 拉 `listRecentMessages`，mainBusy 时不 emit 等下 tick 重 fetch）/ `'push'`（slack：Socket Mode WebSocket 推送，mainBusy 时**仍必须 emit**，错过永久丢失，与 polling 是根本不同原则）。详见 memory `feedback_push_mode_mainbusy`。
- **IM 无关定位**：cc-bot 是 IM 无关的 Claude Code 群 bot 插件，目前已实现 lark + slack；见 memory `feedback_im_agnostic_design`。
- **i18n**：`profile.im.locale` 缺省按 IM 类型决（lark=zh-CN / slack=en-US），覆盖 BUSY 占位 / 上下线通知 / HUD 行；详见 memory `feedback_im_i18n_default`。
- **每项目独立 `.cc-bot/`**：使用 cc-bot 的项目在自己根目录下建 `.cc-bot/profiles/` + `.cc-bot/runtime/`，profile 和运行时状态都跟项目走，多项目互不污染。一项目一 IM。
- **poll.js 无项目假设**：启动参数 `--project <abs-path>`，所有路径基于此。`${CLAUDE_PLUGIN_ROOT}` 由 Claude Code 在插件安装后注入。
- **三层防御**（详见 SKILL §poll.js 三层防御）：PID lockfile / stdout EPIPE / state 未来值自愈。2026-04-20 polling 架构三坑对策，不可删。v0.1.11 试过补第四层（父进程死亡自杀 ppid 重读），cc-bot-test Win 实测发现 bash 中间层导致检测失效已撤回，跨平台反向追溯 CC PID 方案移 v0.1.13+ 候选。

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
| `/cc-bot:doctor` | 只读健康检查（版本漂移 / profile / 运行时 / 僵尸权限 / shim / lark-cli auth） |

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

一键 bump 脚本 `scripts/release.js`：原子更新 `plugin.json` + `marketplace.json` + `package.json` 三处版本号、prepend CHANGELOG.md、commit、tag、（可选）push、（可选）建 GitHub Release。

```bash
node scripts/release.js patch              # 0.1.1 → 0.1.2（默认不推，手工 git push）
node scripts/release.js patch --push       # 写文件 + commit + tag + push main + push tag
node scripts/release.js patch --release    # 一把梭：上面全部 + 自动 gh release create（推荐）
node scripts/release.js minor --dry        # 预览，不写文件（看 changelog entry 合理再执行）
node scripts/release.js 0.2.0              # 指定具体版本号
```

**`--release` 隐含 `--push`**，需要 `gh` CLI 已装并登录。仅 push tag 不会自动出现在 GitHub releases 页面（v0.1.10 撞过此坑），用 `--release` 一把梭最稳。

**一定要用 `node scripts/release.js` 直接调**，不要走 `npm run release`。原因：`npm run release patch --dry` 里 `--dry` 会被 npm 吞掉不传给脚本（见 memory `feedback_npm_run_flag_passthrough`），导致本来想 dry 预览的误跑成真实 release。若坚持走 npm，用 `npm run release -- patch --dry`（`--` 分隔符原样转发）。

preflight 校验：必须在 main 分支、工作区干净、目标 tag 不存在。

发版顺序：① 业务/功能性 commit 先做完、全部推上 main → ② `node scripts/release.js <bump> --release` 一把梭 → ③ 使用 cc-bot 的项目按 README §Updating 跑 3 条命令拉新版。

## 先决条件（使用 cc-bot 的项目需要）

- Claude Code 已安装
- **For lark**：`lark-cli` 已全局安装并完成 `auth login`（bot + user 身份）
- **For slack**（v0.1.12+）：`npm i -g @slack/socket-mode @slack/web-api` 全局装；按 `templates/slack-manifest.yaml` 在 api.slack.com/apps 建 App + 拿 `xoxb-` Bot Token + `xapp-` App-Level Token（scope `connections:write`）
- Shell：**Windows** 用 Git Bash（adapter 底层借 bash shell 传 argv；不能用 PowerShell/cmd）；**macOS/Linux** 系统自带 bash 即可（无须额外配置）
- 按 profile.intents 需要，安装对应 MCP（如 wechat-devtools / chrome-devtools 等，视项目定）

## 相关 memory

通用 memory 在 `~/.claude/projects/D--Projects-cc-bot/memory/`，自动加载。
