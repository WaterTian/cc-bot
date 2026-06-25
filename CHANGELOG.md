# Changelog

All notable changes to **cc-bot** are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

Release history is authoritative at the git tag level — see [GitHub releases](https://github.com/WaterTian/cc-bot/releases). This file is human-readable summary, maintained by `node scripts/release.js`.

## [0.1.43] - 2026-06-25

- fix: 群消息开关意图三层防御 — 拒绝远程 stop/start (#18)
- fix: 收尾 polling_interval_ms 默认 10s 不一致 (#19)
- fix: poll.js degraded 分支自愈 — 心跳停更 ≥15min force-clear 锁，防主会话异常终止后群消息永久漏推 (#20)

## [0.1.42] - 2026-06-17

- fix: 修正 /plugin ... 命令链 — CC 是交互面板，不支持 shell &&

## [0.1.41] - 2026-06-17

- feat: setup §9.5 询问 autoUpdate（default No 保守 opt-in）
- docs: Why CC-BOT 排版优化 — 去 table cell + 中文段用全角破折号
- docs: README 精简（392→362）+ Star History 支持 dark mode

## [0.1.40] - 2026-06-17

- feat: /cc-bot:start §0 Pre-flight self-heal — 升级 7 步降到 2 步

## [0.1.39] - 2026-06-17

- refactor: polling interval 默认 30s → 10s（3× 消息响应速度）
- fix: doctor §4a Bash 权限完备度改 soft match（防误报 ⚠ 缺）
- docs: README 同步 v0.1.35-v0.1.38 - setup §7 Bash 权限集 + Code-driven 表加 3 工具

## [0.1.38] - 2026-06-17

- feat: setup §9 扩 Bash 权限集（IM 分流 + 幂等）+ doctor §4 同步检查

## [0.1.37] - 2026-06-17

- feat: dispatch.js sweep + agents.json version CAS（长任务 wall-clock cap）

## [0.1.36] - 2026-06-17

- feat: runtime/atomic-write.js 统一原子写 + streaming-card hash dedup + doctor 加 .tmp-* 残留扫描
- chore: gitignore .research/ for dev research notes

## [0.1.35] - 2026-06-16

- refactor: 抽 streaming-card-policy.js 统一卡片策略 + register 加 preheated

## [0.1.34] - 2026-06-15

- fix: streaming-card 字面 \n 自动转真换行 + worker.md 极简化

## [0.1.33] - 2026-06-15

- feat: dispatch.js 预热流式卡片 + 孤儿兜底 finalize（issue #15 / #13 / #16）

## [0.1.32] - 2026-06-15

- feat: todo-bridge hook 自动 mirror 主会话 TodoWrite 到流式卡片

## [0.1.31] - 2026-06-15

- fix: worker 中途多报上调到强制（解决"群里只看到最后已完成卡片"翻车）

## [0.1.30] - 2026-06-15

- feat: 换行判据 + slack 端 redact + 文档大同步

## [0.1.29] - 2026-06-15

- feat: streaming-card 设计感升级（文本流 markdown 路线）+ profile migration
- feat: profile 字段升级 backfill + doctor 加 lark-cli 版本/scope 检查

## [0.1.28] - 2026-06-15

- feat: 卡片设计感升级（hr + footer 耗时）+ 上下线通知极简化

## [0.1.27] - 2026-06-15

- fix: streaming-card.js short_threshold + 修首次 final 重复 bug

## [0.1.26] - 2026-06-15

- fix: streaming-card.js isOmId 收紧（v0.1.22 遗留：fake om_ id 走错路径）

## [0.1.25] - 2026-06-15

- feat: 消息调度代码化（dispatch.js 接管 agents.json 全生命周期）

## [0.1.24] - 2026-06-15

- feat: 文本脱敏 + ACK 检测代码化（redact.js + ack-detect.js）

## [0.1.23] - 2026-06-15

- feat: 权限矩阵 + 意图解析代码化（permission.js + intent.js）

## [0.1.22] - 2026-06-15

- feat: lark 流式卡片（CardKit v2 typewriter + 三态 header）

## [0.1.21] - 2026-06-09

- chore(doctor): §2 schema drift 名单加 busy_reaction
- feat: main-busy 期间 emoji reaction ack 信号（issue #12）
- docs(doctor): §2 schema drift 扫顶级误写 IM 字段（issue #11）

## [0.1.20] - 2026-06-04

- fix: poll.js busy-held 持久化 + polling_mode 漂移警告 + im.debug 开关（issue #8 #9）

## [0.1.19] - 2026-06-04

- fix: busy 占位 per-lock 去重 + opt-out 开关（issue #7）

## [0.1.18] - 2026-06-02

- fix: setup 幂等重入路径补 polling_mode 复查

## [0.1.17] - 2026-06-02

- feat: setup 自动检测第三方端点 → self-poll
- docs: HUD 示例版本号更新到 v2.1.142
- docs: 精简 poll-once.md，省 self-poll 每轮 token 开销

## [0.1.16] - 2026-05-26

- docs: 调度会话建议 low effort，worker 扛重活（issue #5）
- feat: worker agent 设 effort: xhigh（官方编码/agentic 推荐起点，issue #5）
- feat: worker agent 加 effort: auto 自适应推理深度（issue #5）
- fix: busy 占位去重改为时间窗口，避免跨 turn 刷屏（issue #6）
- chore: keywords 补 deepseek

## [0.1.15] - 2026-05-25

- chore: gitignore docs/ 目录
- fix: main-busy 锁过期降级模式 — 防主会话阻塞导致群消息假死
- feat: self-poll 模式 — 弱 agentic 端点（DeepSeek）替代 Monitor 收消息
- docs: 更新透明背景 logo.png
- feat: 上下线通知版本行重排 + 下线精简
- docs: README 梳理三处不一致

## [0.1.14] - 2026-05-18

- feat: v0.1.14 — 通知首行加 CC 版本 + marketplace 描述/版本号同步 + README 精简

## [0.1.13] - 2026-05-18

- feat: v0.1.13 候选 — cc-bot:worker agent + acquireLock 失败落盘 + doctor 检查
- docs: v0.1.12 文档同步 + cc-bot logo + Slack manifest 配色

## [0.1.12] - 2026-05-12

- feat: v0.1.12 候选 — Slack adapter（Socket Mode）+ i18n + 跨平台
- docs: 中文 sub-tagline 升级 strong 同字号 + 追加「— 飞书（Lark）」
- docs: 中文 tagline 再精简为「接 AI 进群里开发项目」
- docs: 重写 tagline 表述更准确 — Claude Code 是驱动主体而非群

## [0.1.11] - 2026-05-08

- feat: v0.1.11 候选 — check-image-size 防 dimension_limit + BUSY 池 14→30 + Defense ④ 撤回
- feat: 砍 member-cache.json 单源化 admin 判定 + poll.js Defense ④ 父进程死亡自杀
- chore: scripts/release.js 加 --release 标志一键建 GitHub Release
- docs: gitignore FEEDBACK.md + 详化 v0.1.10 changelog 标注 Mac 实验性
- docs: SKILL §异常路径 — lock-taken 自动 stop+start，去掉 AskUserQuestion 卡片

## [0.1.10] - 2026-04-29

- feat: @他人不搭理 — poll.js 加 mention filter，群里 @ 他人的消息默认不响应（多人协作群降噪）；profile 新增 `im.bot_open_id` 选填字段，配后精准识别"@bot 自己"，未配则保守模式（任何 @ 一律 skip，包括 @ bot — 用自然语言无 @ 即可触发）
- feat: Mac / Linux 系统适配（**实验性**）— `commands/setup.md` Monitor 通配权限按 `process.platform` 选 win32/darwin/linux 模板；`commands/stop.md` 验证残留 poll.js 加 Unix 分支（pgrep -f + kill）；SKILL §关闭流程 / §Shell 安全规范 加 Unix 等价；CLAUDE.md / README.md Prerequisites 去 Windows-only 措辞。代码改动小（绝大部分原本就是跨平台 JS + bash），Mac 端尚未实测，待用户反馈再加固

## [0.1.9] - 2026-04-24

- feat: 主会话忙碌占位文案池 14 条随机（替代固定"主窗口处理中，稍后"）
- docs: SKILL 整体梳理 -44 行
- docs: README 参考 cc-hud 统一风格 — Bun TIP + Unicode 图标 + 卖点 tagline

## [0.1.8] - 2026-04-24

- fix: 升级路径自愈 + doctor tokenStatus 分档 + SKILL ! 命令 caveat

## [0.1.7] - 2026-04-24

- docs: SKILL 精简 17 行 + 清除 8 处外发死链 memory 引用

## [0.1.6] - 2026-04-23

- feat: 主会话优先级 — 主窗口对话期间群消息让路
- docs: 明确"主窗口对话"定义（人类键入为主；自动触发 / subagent 完成也 lock，基于 CC 限制与单线程主会话的合理权衡）

## [0.1.5] - 2026-04-23

- feat: 多 agent 调度架构 + poll.js EPIPE 容错

## [0.1.4] - 2026-04-22

- docs: README 加 version badge（shields.io GitHub tag）
- docs: README 同步 v0.1.3/0.1.4 UX 改动
- docs: README Updating 段加升级后版本验证指引
- feat: 上下线通知也带版本号
- feat: /cc-bot:setup 开场显示版本号，完成提示也带版本

## [0.1.3] - 2026-04-22

- feat: /cc-bot:setup step 9 自动注册 Monitor 通配权限
- docs: CLAUDE.md 发版示例改用 node scripts/release.js 直接调

## [0.1.2] - 2026-04-22

- feat: 加 scripts/release.js 一键发版脚本 + CHANGELOG.md
- feat: 加 /cc-bot:doctor 健康检查命令 + README Updating 升级指南

## [0.1.1] - 2026-04-22

### Added
- SKILL.md §Monitor 异常重启 — 5-step restart recipe (state.json → TaskGet → branch → re-Monitor → verify)
- SKILL.md §成员缓存 — format example (3 sample entries, admin vs member)

### Changed
- SKILL.md trimmed 3 duplicated sections (685 → 677 lines)
  - §启动流程 §明确不做的事 — removed 回滚条件 sub-items (they live in `commands/start.md`)
  - §开关通知 §字段规则 — collapsed 5 field rules into single reference to §HUD 状态推送
  - §Monitor 异常时 API 兜底 — removed historical events.log deprecation sentence

### Fixed
- 上下线通知改用 `lark-cli --content '{"text":"..."}'` JSON 方式 — 根治 Windows Git Bash `$'...\n...'` 转义在群里显示为字面 `\n` 的问题

## [0.1.0] - 2026-04-21

### Added
- **Initial public release** on GitHub (`WaterTian/cc-bot`) + Claude Code plugin marketplace
- **Plugin structure**：5 slash commands (`setup` / `start` / `stop` / `new-profile` / `switch`), 1 skill (`lark-bot`), runtime (`poll.js` / `statusline.js`), adapters (`base.js` / `lark.js`), profile template
- **IMAdapter abstraction** — 5-method interface (`listRecentMessages` / `sendText` / `sendImage` / `downloadResource` / `getUser`); Lark implementation ships, others extensible
- **Monitor + HTTP 30s polling** with 3-layer defense
  - PID lockfile (`.cc-bot/runtime/poll.pid`) single-instance guard
  - `stdout.writable` + EPIPE self-kill (prevents orphan polluting `poll.emitted`)
  - `state.last_processed_time` future-value self-heal (down to `now - 60s`)
- **Interactive 5-stage setup wizard** — all-AskUserQuestion cards, idempotent; auto-installs lark-cli, OAuth login guide, chat picker (existing or new-create), auto-detect `bot_app_id` / `admin_open_id`, pre-fill `member-cache.json`, register statusline shim
- **Per-project `.cc-bot/` isolation** — profile / runtime / bot_temp all under project root, zero cross-contamination
- **Statusline shim** (`runtime/statusline.js`) — tees stdin JSON to `hud-stdin.json` for bot HUD intent; tees to cc-hud renderer if installed
- **Pre-commit privacy scan** (`scripts/pre-commit-scan.sh`) — blocks real Lark IDs + name blocklist + api-secret patterns
