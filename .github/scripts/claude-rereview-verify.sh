#!/usr/bin/env bash
# claude-rereview-verify.sh — re-review 的确定性收尾校验，管两件事：
#
# 1) 本次是否真的产出了新 review。零产出时 job 会绿着退出、merge-gate 走到第 4 条 skip，
#    PR 无声退回「线程都清了、CI 全绿、就是不合并」的卡死态——与本机制要修的症状一模一样，
#    且没有任何红色信号提示需要再触发一次。
#    注意不能复用 claude-review-verify.sh：它查的是「是否存在 claude[bot] 对 head 的有效
#    review」，而重裁场景下 PR 上本来就有历史的 COMMENTED@head，那个校验会被历史 review
#    直接满足。这里改为比对 review id：必须有比开跑前更新的一条。
#
# 2) claude 运行期间 head 是否漂移。`gh pr review --approve` 不带 commit_id，GitHub 按
#    提交时刻的最新 head 记账（REST：Defaults to the most recent commit），若期间有 push，
#    APPROVED 会落在 claude 从未看过的 commit 上；而 merge-gate 第 5 条的 checks 等待显式
#    排除了 Claude PR Review workflow，不会等新 push 触发的首轮 review 跑完来纠正，
#    第 6 条 --match-head-commit 用的也是同一个新 head——未审查的代码会被直接合并。
#    这类错位的 APPROVED 还会持久毒化后续判定（下一条 @claude 会因「已是 APPROVED@head」
#    跳过重裁），所以必须当场 dismiss，而不只是让 job 置红。
#    （claude-review.yml 靠 concurrency: cancel-in-progress 免疫同类竞态：push 会立刻取消
#    在跑的 review，approve 来不及落地。discuss workflow 没有取消保护，只能事后校验。）
#
# 必需环境变量：GH_TOKEN、GITHUB_REPOSITORY、PR_NUMBER、EXPECTED_HEAD、PREV_REVIEW_ID
set -euo pipefail

repo="$GITHUB_REPOSITORY"
pr="$PR_NUMBER"

reviews=$(gh api "repos/$repo/pulls/$pr/reviews" --paginate \
  --jq '.[] | select(.user.login == "claude[bot]")' | jq -s '.')
# 只认有效裁决：APPROVED，或带正文的 review。GitHub 会为行内评论/线程回复自动生成
# 空正文的隐式 COMMENTED review，其 id 必然大于 prev——模型挂了行内评论却忘了收尾
# （#33 那类提前收工），不过滤就会被判成「已提交」，job 绿着退回无声卡死态。
# 这也让下面的 dismiss 目标更稳：last 取到的一定是真裁决，而不是恰好垫在最后的空 review
# （那种情况下真正的 APPROVED 会逃过 dismiss）。
new_review=$(jq --argjson prev "${PREV_REVIEW_ID:-0}" \
  'map(select(.id > $prev and (.state == "APPROVED" or ((.body // "") | length > 0)))) | last // empty' <<<"$reviews")

if [ -z "$new_review" ]; then
  echo "::error::re-review 未提交任何 review（零产出）。PR 仍停在未裁决状态，需再发一条 @claude 评论重新触发"
  exit 1
fi

new_id=$(jq -r '.id' <<<"$new_review")
new_state=$(jq -r '.state' <<<"$new_review")
echo "re-review 已提交 review：id=${new_id} state=${new_state}"

current_head=$(gh pr view "$pr" -R "$repo" --json headRefOid --jq '.headRefOid')
if [ "$current_head" = "$EXPECTED_HEAD" ]; then
  echo "head 未变（${current_head}），校验通过"
  exit 0
fi

echo "::warning::re-review 运行期间 head 从 ${EXPECTED_HEAD} 变为 ${current_head}"

# dismiss 本轮新增的**全部** APPROVED，而不只是最后一条：模型可能在一次运行里提交多条
# （典型诱因是 gh pr review --approve 超时报错但实际已落地，模型据此重试——allowedTools
# 不限制提交次数）。只清最后一条会让更早那条错位的 APPROVED 存活成为最新有效 review，
# 下一条 @claude 便会因 need 判「已是 APPROVED@head」跳过重裁，merge-gate 随即放行两个
# head 之间无人看过的 diff——正是本文件头部注释要防的那条持久毒化链。
# 只有 APPROVED / CHANGES_REQUESTED 可被 dismiss；COMMENTED 即使错位也不会让 merge-gate 放行。
dismissed=0
while read -r rid; do
  [ -n "$rid" ] || continue
  gh api --method PUT "repos/$repo/pulls/$pr/reviews/${rid}/dismissals" \
    -f message="re-review 运行期间出现新提交（${EXPECTED_HEAD:0:8} → ${current_head:0:8}），本次 APPROVED 针对的不是被审查的代码，自动撤销。新提交会触发一轮全新 review。" \
    -f event=DISMISS >/dev/null
  echo "已 dismiss 错位的 APPROVED（id=${rid}）"
  dismissed=$((dismissed + 1))
done < <(jq -r --argjson prev "${PREV_REVIEW_ID:-0}" \
           '.[] | select(.id > $prev and .state == "APPROVED") | .id' <<<"$reviews")
echo "本轮 dismiss 的错位 APPROVED 数：${dismissed}"

echo "::error::head 在 re-review 期间发生漂移，本次裁决作废；新提交将由 Claude PR Review 重新审查"
exit 1
