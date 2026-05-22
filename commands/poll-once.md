---
name: poll-once
description: cc-bot self-poll 单轮 — 拉一次群消息并回复（由 /loop 每轮驱动；仅 polling_mode=self-poll 使用，不是给人手动调的）
---

cc-bot **self-poll 模式的单轮处理**，由 `/loop` 每轮自动调用。目标：拉一次新消息 → 逐条回群 → 推进 state；无新消息则极简退出省 token。

> 仅用于 `profile.polling_mode === 'self-poll'`（DeepSeek 等弱 agentic 端点无法用 Monitor 时的替代）。Monitor 模式不走这里。

### 执行

1. **Read** `.cc-bot/profiles/active.json`：拿 `project.root` / `im.chat_id` / `im.type` / `members.admin_open_ids`。

2. **Bash 拉新消息**（复用 poll.js 的去重 / ＠他人过滤 / 类型过滤，不要自己 fetch 判断）：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/runtime/poll.js --once --project <project.root>
   ```
   stdout 每行一条 `NEW_MSG|{msg_id}|{sender}|{content}|{time}`（可能 0 行）。

3. **分支**：
   - **无 NEW_MSG 行** → 只回一句「本轮无新消息」**立即结束**，不做任何别的（省 token —— self-poll 控成本的关键，loop 会在下轮再来）。
   - **有 NEW_MSG 行** → 按 `${CLAUDE_PLUGIN_ROOT}/skills/lark-bot/SKILL.md` §消息处理 SOP **逐条**处理（按 create_time 升序）：角色判定 → 意图识别 → **真的用 `lark-cli im +messages-reply` 回群** → 回复后 Edit `.cc-bot/runtime/state.json` 推进 `last_processed_time` 到该条 createTimeMs。

4. 处理完**结束本轮**，不要自己再轮询（loop 自动调度下一轮）。

### 关键约束

- **回群只有发起 `lark-cli +messages-reply` 的 tool_use 才算数**；在主会话里说「已回复」不算（SKILL §最高优先级规则 0：回群=工具调用，宣告不算数）。每条 NEW_MSG 必须以一次真实回群收尾，否则这条消息丢了。
- `poll.js --once` 已做去重（`poll.emitted`）+ ＠他人 + 类型过滤，stdout 给到的就是该处理的，**别再自己拉历史核对**。
- 无新消息轮**保持极简一句话** —— 这是 self-poll 控 token 的关键（尤其 DeepSeek 端点 prompt 缓存失效，每轮全量 input）。
