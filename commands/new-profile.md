---
name: new-profile
description: Create a new cc-bot profile from template (usage: /cc-bot:new-profile <name>)
---

Create a new cc-bot profile file in the current project from the template.

Usage: `/cc-bot:new-profile <name>`

Steps:

1. Parse `<name>` from the slash command argument. If missing, ask "请提供 profile 名（如 fantown）".
2. Verify `.cc-bot/profiles/template.json` exists. If not, suggest running `/cc-bot:setup` first.
3. Verify `.cc-bot/profiles/<name>.json` does NOT exist. If it does, ask the user to confirm overwrite or pick another name.
4. Copy `.cc-bot/profiles/template.json` to `.cc-bot/profiles/<name>.json`.
5. Set `profile_name` field in the new file to `<name>` (Edit the JSON).
6. Tell the user: "已建 `.cc-bot/profiles/<name>.json`。编辑填好字段后，用 `/cc-bot:switch <name>` 切换为激活 profile。"

Do NOT automatically switch — user fills fields first.
