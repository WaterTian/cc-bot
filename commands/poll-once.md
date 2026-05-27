---
name: poll-once
description: cc-bot self-poll 单轮 — 拉一次群消息并回复（由 /loop 每轮驱动；仅 polling_mode=self-poll 使用）
---

self-poll 单轮处理，由 `/loop` 每轮调用。

### 执行

1. Read `.cc-bot/profiles/active.json`，拿 `project.root`。
2. Bash：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/runtime/poll.js --once --project <project.root>
   ```
3. 分支：
   - **无 NEW_MSG** → 立即结束，不输出（loop 会在下轮再来）。
   - **有 NEW_MSG** → 按 SKILL.md §消息处理 SOP 逐条回群 + 推进 state。

### 约束

- `poll.js --once` 已做去重 + @过滤 + 类型过滤，**不再自己拉历史核对**。
- 回群 = 发起 `lark-cli +messages-reply` 才算数，主会话里说「已回复」不算。
