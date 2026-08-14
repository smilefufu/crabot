#!/usr/bin/env bash
# claude-review-verify.sh 回归测试：第二页命中的 review 必须被计入。
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin"

cat > "$tmp_dir/bin/gh" <<'EOF'
#!/usr/bin/env bash
# 旧查询逐页返回 0 和 1；修复后的查询跨页输出唯一一条匹配 review 的 ID。
query=${!#}
if [[ "$query" == *'] | length'* ]]; then
  printf '0\n1\n'
else
  printf '4933087302\n'
fi
EOF
chmod +x "$tmp_dir/bin/gh"

output_file="$tmp_dir/github-output"
PATH="$tmp_dir/bin:$PATH" \
  GITHUB_REPOSITORY='smilefufu/crabot' PR_NUMBER='92' HEAD_SHA='test-head' \
  GITHUB_OUTPUT="$output_file" \
  bash "$repo_root/.github/scripts/claude-review-verify.sh" >/dev/null 2>&1

grep -qx 'ok=true' "$output_file"
echo 'claude-review-verify pagination test passed'
