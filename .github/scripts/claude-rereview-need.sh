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

# 3. 必须已有首轮 review。为空说明首轮还在跑、或 review job 失败/被取消——
#    此时「未解决线程数为 0」的含义是「从来没审过」，不是「问题都清完了」，
#    而重裁的 prompt 建立在「首轮已做过」的前提上，会产出一个浅层 APPROVED，
#    把从未经过完整 review 的 PR 直接送进 merge-gate（其 checks 等待又排除了
#    Claude PR Review workflow，不会等首轮跑完来纠正）。
last_review=$(gh api "repos/$repo/pulls/$pr/reviews" --paginate \
  --jq '.[] | select(.user.login == "claude[bot]")
            | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "COMMENTED")' \
  | jq -s 'last // empty') || no "无法获取 review 列表"
[ -n "$last_review" ] || no "claude[bot] 尚无首轮 review（重裁只适用于首轮已完成的 PR）"

# 4. 首轮 review 必须针对当前 head。指向旧 head 说明此后有过 push，而那次 push 的完整
#    review 要么还在跑、要么已置红——此时重裁的前提（「没有新提交」「代码未变」）为假：
#    prompt 会让模型只复核既有线程范围就 approve，两个 head 之间线程范围之外的改动
#    等于没被任何人看过，而 merge-gate 第 5 条的 checks 等待又排除了 Claude PR Review
#    workflow，in-flight 或置红的首轮 review 都拦不住。新提交一律交给 push 触发的完整
#    review 处理，不归重裁管。
[ "$(jq -r '.commit_id' <<<"$last_review")" = "$head_sha" ] \
  || no "最新 review 针对的不是当前 head（新提交应由 push 触发的完整 review 处理）"

# 5. 已经是 APPROVED 就不必重跑（避免每条评论都触发一次）
[ "$(jq -r '.state' <<<"$last_review")" != "APPROVED" ] \
  || no "最新 review 已是针对当前 head 的 APPROVED"

# head_sha 与 last_review_id 交给收尾校验（claude-rereview-verify.sh）：
# 前者用于检测 claude 运行期间 head 是否漂移，后者用于判定本次是否真的产出了新 review。
echo "re-review: 线程已全部 resolve，且尚无针对 head ${head_sha} 的 APPROVED，需要重新裁决"
echo "needed=true" >> "$GITHUB_OUTPUT"
echo "head_sha=${head_sha}" >> "$GITHUB_OUTPUT"
echo "last_review_id=$(jq -r '.id' <<<"$last_review")" >> "$GITHUB_OUTPUT"
