#!/usr/bin/env bash
# claude-rereview-need.sh — 判定讨论后是否需要重新裁决。
#
# 背景：review 首轮若有未解决问题，收尾动作是 `gh pr review --comment`，state 落成 COMMENTED。
# 若剩余争议是在讨论区被澄清、线程被 resolve 掉的（而非靠改代码），就不会产生新 commit；
# 而 Claude PR Review 只监听 pull_request 事件，没有 push 就不会重跑，PR 永久停在 COMMENTED，
# merge-gate 第 4 条（最新 review 须为针对 head 的 APPROVED）因此永远不满足（crabot #59 实锤）。
#
# 必需环境变量：GH_TOKEN、GITHUB_REPOSITORY、PR_NUMBER、GITHUB_OUTPUT
# 输出：needed=true/false。任何查询失败一律 needed=false（fail-closed，宁可不合并不可误合并）。
set -euo pipefail

repo="$GITHUB_REPOSITORY"
pr="$PR_NUMBER"

no() { echo "re-review: $1 — 跳过重裁"; echo "needed=false" >> "$GITHUB_OUTPUT"; exit 0; }

# 显式检查依赖：缺 jq 时下面每个 $(jq ...) 都会取到空串，会把失败伪装成
# "PR 不是 open 状态" 这类误导性结论，排查时按错误方向查
for dep in gh jq; do
  command -v "$dep" >/dev/null 2>&1 || no "缺少依赖 $dep"
done

# 1. PR 基本状态
pr_json=$(gh pr view "$pr" -R "$repo" --json state,isDraft,headRefOid) || no "无法获取 PR 状态"
[ "$(jq -r '.state' <<<"$pr_json")" = "OPEN" ] || no "PR 不是 open 状态"
[ "$(jq -r '.isDraft' <<<"$pr_json")" = "false" ] || no "PR 是 draft"
head_sha=$(jq -r '.headRefOid' <<<"$pr_json")

# 2. 线程必须全部 resolve：还有未解决线程说明讨论没结束，重裁没有意义
#    （这一条同时挡住「@claude 请直接 approve」这类评论——问题没清完就到不了 claude 调用）
owner="${repo%/*}"; name="${repo#*/}"
threads_json=$(gh api graphql \
  -f query='query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}}}}' \
  -f owner="$owner" -f name="$name" -F pr="$pr") || no "无法查询 review 线程"
[ "$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' <<<"$threads_json")" = "false" ] \
  || no "review 线程超过 100 个，无法完整校验"
unresolved=$(jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length' <<<"$threads_json")
[ "$unresolved" = "0" ] || no "还有 $unresolved 个未 resolve 的 review 线程"

# 3. 已经是针对当前 head 的 APPROVED 就不必重跑（避免每条评论都触发一次）
last_review=$(gh api "repos/$repo/pulls/$pr/reviews" --paginate \
  --jq '.[] | select(.user.login == "claude[bot]")
            | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "COMMENTED")' \
  | jq -s 'last // empty') || no "无法获取 review 列表"
if [ -n "$last_review" ] \
   && [ "$(jq -r '.state' <<<"$last_review")" = "APPROVED" ] \
   && [ "$(jq -r '.commit_id' <<<"$last_review")" = "$head_sha" ]; then
  no "最新 review 已是针对当前 head 的 APPROVED"
fi

# 已知竞态：若此刻正好有新 push 触发的 review job 在跑，两边可能同时提交 review。
# 后果可控——双方面对的是同一个 head，且 merge-gate 仍要求最新 review 为 APPROVED@head
# 且线程全清，不会放行未经审查的代码；因此不额外加锁。
echo "re-review: 线程已全部 resolve，且尚无针对 head ${head_sha} 的 APPROVED，需要重新裁决"
echo "needed=true" >> "$GITHUB_OUTPUT"
