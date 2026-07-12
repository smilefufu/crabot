#!/usr/bin/env bash
# claude-merge-gate.sh — 确定性合并闸门：全部条件满足才执行 squash 合并。
# 必需环境变量：GH_TOKEN、GITHUB_REPOSITORY、PR_NUMBER、ALLOWLIST（逗号分隔登录名）
set -euo pipefail

repo="$GITHUB_REPOSITORY"
pr="$PR_NUMBER"

skip() { echo "merge-gate: $1 — 跳过合并"; exit 0; }

# 登录名归一化：去掉 app/ 前缀与 [bot] 后缀
norm() { local s="${1#app/}"; s="${s%\[bot\]}"; printf '%s\n' "$s" | tr '[:upper:]' '[:lower:]'; }

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
threads_json=$(gh api graphql \
  -f query='query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}}}}' \
  -f owner="$owner" -f name="$name" -F pr="$pr")
[ "$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' <<<"$threads_json")" = "false" ] \
  || skip "review 线程超过 100 个，无法完整校验"
unresolved=$(jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length' <<<"$threads_json")
[ "$unresolved" = "0" ] || skip "还有 $unresolved 个未 resolve 的 review 线程"

# 4. Claude（claude[bot]）的最新 review 必须是针对当前 head 的 APPROVED
head_sha=$(jq -r '.headRefOid' <<<"$pr_json")
last_review=$(gh api "repos/$repo/pulls/$pr/reviews" --paginate \
  --jq '.[] | select(.user.login == "claude[bot]")
            | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "COMMENTED")' \
  | jq -s 'last // empty')
[ -n "$last_review" ] || skip "尚无 Claude 的 review"
[ "$(jq -r '.state' <<<"$last_review")" = "APPROVED" ] || skip "Claude 最新 review 不是 APPROVED"
[ "$(jq -r '.commit_id' <<<"$last_review")" = "$head_sha" ] || skip "APPROVED 针对的不是当前 head（有未 review 的新提交）"

# 5. CI checks：排除本套 workflow 自身，等待其余 checks 完成（最长 30 分钟）
pending=0
fetch_fail=0
for _ in $(seq 1 60); do
  checks_json=$(gh pr checks "$pr" -R "$repo" --json name,state,workflow 2>/dev/null) || true
  if ! jq -e . >/dev/null 2>&1 <<<"$checks_json"; then
    # 拿不到合法 JSON：区分“无 checks”与调用失败（失败重试，连续 3 次才放弃；绝不当作无 checks）
    err=$(gh pr checks "$pr" -R "$repo" --json name,state,workflow 2>&1 >/dev/null) || true
    case "$err" in
      *"no checks reported"*) checks_json="[]" ;;
      *)
        fetch_fail=$((fetch_fail + 1))
        [ "$fetch_fail" -lt 3 ] || skip "无法获取 CI checks（gh 连续失败：${err:-未知错误}）"
        echo "merge-gate: 获取 CI checks 失败，重试（$fetch_fail/3）..."
        sleep 30
        continue
        ;;
    esac
  fi
  fetch_fail=0
  checks=$(jq '[.[] | select(.workflow != "Claude PR Review" and .workflow != "Claude PR Discuss")]' <<<"$checks_json")
  pending=$(jq '[.[] | select(.state == "PENDING" or .state == "QUEUED" or .state == "IN_PROGRESS" or .state == "WAITING")] | length' <<<"$checks")
  # 通过状态白名单：清单外的任何状态（ACTION_REQUIRED/STARTUP_FAILURE/STALE 等）一律按失败处理，fail-closed
  failed=$(jq '[.[] | select((.state == "SUCCESS" or .state == "SKIPPED" or .state == "NEUTRAL" or .state == "PENDING" or .state == "QUEUED" or .state == "IN_PROGRESS" or .state == "WAITING") | not)] | length' <<<"$checks")
  [ "$failed" = "0" ] || skip "有 $failed 个 CI check 未通过"
  [ "$pending" = "0" ] && break
  echo "merge-gate: 等待 $pending 个 CI check..."
  sleep 30
done
[ "$pending" = "0" ] || skip "等待 CI 超时（30 分钟）"

# 6. 合并：钉住已验证的 head，等待期间有新提交则安全放弃；先合并后评论
echo "merge-gate: 所有条件满足，执行 squash 合并"
gh pr merge "$pr" -R "$repo" --squash --delete-branch --match-head-commit "$head_sha" \
  || skip "合并未执行（可能等待期间有新提交，或 PR 已被合并）"
gh pr comment "$pr" -R "$repo" --body "✅ 所有 review 意见已解决且检查通过，由自动流程执行 squash 合并。" || true
