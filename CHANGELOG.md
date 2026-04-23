# Changelog

All notable changes to **cc-bot** are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

Release history is authoritative at the git tag level — see [GitHub releases](https://github.com/WaterTian/cc-bot/releases). This file is human-readable summary, maintained by `node scripts/release.js`.

## [0.1.6] - 2026-04-23

- feat: 主会话优先级 — 主窗口对话期间群消息让路

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
