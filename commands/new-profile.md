---
name: new-profile
description: Create a new cc-bot profile from template (usage: /cc-bot:new-profile <name>)
---

Create a new cc-bot profile file in the current project from the template.

Usage: `/cc-bot:new-profile <name>`

Steps:

1. Parse `<name>` from the slash command argument. If missing, ask "请提供 profile 名（如 `myproject`）"（文字输入，不用卡片）。
2. Verify `.cc-bot/profiles/template.json` exists. If not, suggest running `/cc-bot:setup` first.
3. Verify `.cc-bot/profiles/<name>.json` does NOT exist. If it does, ask via **AskUserQuestion**：
   ```
   AskUserQuestion({
     questions: [{
       question: "`.cc-bot/profiles/{name}.json` 已存在，覆盖吗？",
       header: "文件冲突",
       multiSelect: false,
       options: [
         { label: "覆盖 (Recommended)", description: "用 template 重置内容；当前内容会丢失" },
         { label: "取消", description: "保留现有文件；换个名字再跑 /cc-bot:new-profile <新名>" }
       ]
     }]
   })
   ```
   - 选「覆盖」→ 继续 step 4
   - 选「取消」→ abort
4. Copy `.cc-bot/profiles/template.json` to `.cc-bot/profiles/<name>.json`.
5. Set `profile_name` field in the new file to `<name>` (Edit the JSON).
6. Tell the user: "已建 `.cc-bot/profiles/<name>.json`。编辑填好字段后，用 `/cc-bot:switch <name>` 切换为激活 profile。"

Do NOT automatically switch — user fills fields first.
