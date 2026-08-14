#!/usr/bin/env bash
# review job 的确定性收尾校验：claude[bot] 是否已对当前 head 提交有效 review
# （APPROVED，或带非空正文的 review；空正文 COMMENTED 视为无效——那是"忘了 approve"的残留）。
# 模型偶发"提前收工"不提交 review（run 绿但零产出），靠 workflow 里的重试步骤兜底；
# FINAL=true 时仍无有效 review 则退出非零，把整个 job 置红（fail-closed，merge-gate 不会放行）。
set -euo pipefail

# --paginate 会逐页执行 --jq；输出匹配 review 的 ID 后统一数行，避免把多页计数（如 "0\n3"）
# 当成单个整数，误触发 attempt 2/3。
count=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/reviews" --paginate --jq \
  ".[] | select(.user.login==\"claude[bot]\" and .commit_id==\"${HEAD_SHA}\" and (.state==\"APPROVED\" or ((.body // \"\") | length > 0))) | .id" \
  | awk 'END { print NR + 0 }')

echo "claude[bot] 对 head ${HEAD_SHA} 的有效 review 数：${count}"
if [ "${count}" -gt 0 ]; then
  echo "ok=true" >> "${GITHUB_OUTPUT}"
else
  echo "ok=false" >> "${GITHUB_OUTPUT}"
  if [ "${FINAL:-false}" = "true" ]; then
    echo "::error::Claude 多次尝试后仍未对当前 head 提交 review（提前收工），job 置红待人工处理"
    exit 1
  fi
fi
