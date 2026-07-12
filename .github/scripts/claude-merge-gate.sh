#!/usr/bin/env bash
# claude-merge-gate.sh — 确定性合并闸门：全部条件满足才执行 squash 合并。
# 必需环境变量：GH_TOKEN、GITHUB_REPOSITORY、PR_NUMBER、ALLOWLIST（逗号分隔登录名）
set -euo pipefail

repo="$GITHUB_REPOSITORY"
pr="$PR_NUMBER"

skip() { echo "merge-gate: $1 — 跳过合并"; exit 0; }

# 登录名归一化：去掉 app/ 前缀与 [bot] 后缀
norm() { local s="${1#app/}"; echo "${s%\[bot\]}"; }

# 1. PR 基本状态（mergeable 刚计算时可能为 UNKNOWN，重试最多 6 次）
mergeable="UNKNOWN"
for _ in 1 2 3 4 5 6; do
  pr_json=$(gh pr view "$pr" -R "$repo" --json state,isDraft,mergeable,author,headRefOid)
  mergeable=$(jq -r '.mergeable' <<<"$pr_json")
  [ "$mergeable" != "UNKNOWN" ] && break
  sleep 5
done
[ "$(jq -r '.state' <<<"$pr_json")" = "OPEN" ] || skip "PR 不是 open 状态"
[ "$(jq -r '.isDraft' <<<"$pr_json")" = "false" ] || skip "PR 是 draft"
[ "$mergeable" = "MERGEABLE" ] || skip "PR 不可合并（mergeable=$mergeable）"

# 2. 作者在白名单内
author=$(jq -r '.author.login' <<<"$pr_json")
author_norm=$(norm "$author")
ok=""
IFS=',' read -ra allow <<<"$ALLOWLIST"
for a in "${allow[@]}"; do
  a_trim=$(echo "$a" | xargs)
  [ -z "$a_trim" ] && continue
  [ "$(norm "$a_trim")" = "$author_norm" ] && ok=1
done
[ -n "$ok" ] || skip "作者 $author 不在白名单"

# 3. 所有 review 线程已 resolved
owner="${repo%/*}"; name="${repo#*/}"
unresolved=$(gh api graphql \
  -f query='query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){nodes{isResolved}}}}}' \
  -f owner="$owner" -f name="$name" -F pr="$pr" \
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length')
[ "$unresolved" = "0" ] || skip "还有 $unresolved 个未 resolve 的 review 线程"

# 4. Claude（claude[bot]，兜底 github-actions[bot]）的最新 review 必须是针对当前 head 的 APPROVED
head_sha=$(jq -r '.headRefOid' <<<"$pr_json")
last_review=$(gh api "repos/$repo/pulls/$pr/reviews" --paginate \
  --jq '.[] | select(.user.login == "claude[bot]" or .user.login == "github-actions[bot]")
            | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "COMMENTED")' \
  | jq -s 'last // empty')
[ -n "$last_review" ] || skip "尚无 Claude 的 review"
[ "$(jq -r '.state' <<<"$last_review")" = "APPROVED" ] || skip "Claude 最新 review 不是 APPROVED"
[ "$(jq -r '.commit_id' <<<"$last_review")" = "$head_sha" ] || skip "APPROVED 针对的不是当前 head（有未 review 的新提交）"

# 5. CI checks：排除本套 workflow 自身，等待其余 checks 完成（最长 30 分钟）
pending=0
for _ in $(seq 1 60); do
  checks_json=$(gh pr checks "$pr" -R "$repo" --json name,state,workflow 2>/dev/null) || true
  if ! jq -e . >/dev/null 2>&1 <<<"$checks_json"; then
    # 拿不到合法 JSON：区分"无 checks"与真实调用失败（失败时安全退出，绝不当作无 checks）
    err=$(gh pr checks "$pr" -R "$repo" --json name,state,workflow 2>&1 >/dev/null) || true
    case "$err" in
      *"no checks reported"*) checks_json="[]" ;;
      *) skip "无法获取 CI checks（gh 调用失败：${err:-未知错误}）" ;;
    esac
  fi
  checks=$(jq '[.[] | select(.workflow != "Claude PR Review" and .workflow != "Claude PR Discuss")]' <<<"$checks_json")
  failed=$(jq '[.[] | select(.state == "FAILURE" or .state == "ERROR" or .state == "CANCELLED" or .state == "TIMED_OUT")] | length' <<<"$checks")
  pending=$(jq '[.[] | select(.state == "PENDING" or .state == "QUEUED" or .state == "IN_PROGRESS" or .state == "WAITING")] | length' <<<"$checks")
  [ "$failed" = "0" ] || skip "有 $failed 个 CI check 失败"
  [ "$pending" = "0" ] && break
  echo "merge-gate: 等待 $pending 个 CI check..."
  sleep 30
done
[ "$pending" = "0" ] || skip "等待 CI 超时（30 分钟）"

# 6. 合并
echo "merge-gate: 所有条件满足，执行 squash 合并"
gh pr comment "$pr" -R "$repo" --body "✅ 所有 review 意见已解决且检查通过，由自动流程执行 squash 合并。"
gh pr merge "$pr" -R "$repo" --squash --delete-branch
