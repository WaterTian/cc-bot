#!/usr/bin/env bash
# cc-bot pre-commit 隐私扫描 —— 阻止敏感信息入仓
#
# 安装方式（在 cc-bot 仓库根目录跑一次）:
#   git config core.hooksPath scripts/hooks
#   mkdir -p scripts/hooks
#   ln -sf ../pre-commit-scan.sh scripts/hooks/pre-commit
# Windows Git Bash 不支持 symlink，改为复制:
#   cp scripts/pre-commit-scan.sh scripts/hooks/pre-commit
#
# 手动跳过（确需提交已脱敏的 demo 数据）:
#   git commit --no-verify ...
#
# 规则:
#   1. 飞书真实 ID 形态（cli_ / ou_ / oc_ / om_ 后接 ≥14 位 hex）— 占位符 cli_xxxxxxxxxxxx 等不拦
#   2. scripts/blocklist.txt 列出的真名 —— 一行一个，# 开头为注释（blocklist.txt 本身 gitignore，不进库）
#   3. app_secret / api_key / bearer token 等常见 secret 字符串

set -e

REPO=$(git rev-parse --show-toplevel)
cd "$REPO"

DIFF=$(git diff --cached --no-color --diff-filter=AM)
# --diff-filter=AM: 只检查新增(A)和修改(M)，删除行不检查
# 只看 + 行（新增内容），不看 - 行（删除的旧内容不重要）
ADDED=$(echo "$DIFF" | grep -E '^\+[^+]' || true)

FAIL=0

# 规则 1: 飞书真实 ID
LARK_ID_HITS=$(echo "$ADDED" | grep -oE '(cli|ou|oc|om)_[0-9a-f]{14,}' || true)
LARK_ID_REAL=$(echo "$LARK_ID_HITS" | grep -vE '_x{14,}|_[0-9a-f]{0,13}$' || true)
if [ -n "$LARK_ID_REAL" ]; then
  echo "❌ pre-commit 阻止：检测到疑似真实飞书 ID"
  echo "$LARK_ID_REAL" | sort -u | head -5 | sed 's/^/     /'
  echo "   → 请改为占位符（cli_xxxxxxxxxxxx / ou_xxxxxxxxxxxx 等）"
  FAIL=1
fi

# 规则 2: 真名黑名单（scripts/blocklist.txt，本地文件）
if [ -f scripts/blocklist.txt ]; then
  while IFS= read -r NAME || [ -n "$NAME" ]; do
    [ -z "$NAME" ] && continue
    case "$NAME" in \#*) continue ;; esac
    if echo "$ADDED" | grep -F -- "$NAME" >/dev/null 2>&1; then
      echo "❌ pre-commit 阻止：检测到真名「$NAME」（scripts/blocklist.txt）"
      FAIL=1
    fi
  done < scripts/blocklist.txt
fi

# 规则 3: 常见 secret
SECRET_HITS=$(echo "$ADDED" | grep -iE 'app[_-]?secret\s*[=:]\s*["'"'"']?[a-z0-9]{16,}|api[_-]?key\s*[=:]\s*["'"'"']?[a-z0-9]{20,}|bearer\s+[a-z0-9_.-]{20,}' || true)
if [ -n "$SECRET_HITS" ]; then
  echo "❌ pre-commit 阻止：疑似 secret / api_key / bearer token"
  echo "$SECRET_HITS" | head -3 | sed 's/^/     /'
  FAIL=1
fi

if [ $FAIL -eq 1 ]; then
  echo ""
  echo "确认内容已脱敏后可用 git commit --no-verify 绕过（谨慎）"
  exit 1
fi

exit 0
