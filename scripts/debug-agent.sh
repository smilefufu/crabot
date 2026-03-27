#!/bin/bash
# =============================================================================
# Crabot Agent 调试脚本
#
# 封装常用调试 RPC 查询，适用于所有 Agent 模块实现
# 详细用法说明：docs/agent-debugging.md
# =============================================================================

set -euo pipefail

# ── 默认端口 ─────────────────────────────────────────────────────────────────
MM_PORT="${CRABOT_MM_PORT:-19000}"
ADMIN_PORT="${CRABOT_ADMIN_PORT:-19001}"
AGENT_PORT="${CRABOT_AGENT_PORT:-19005}"

# ── 颜色 ─────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── 基础工具 ──────────────────────────────────────────────────────────────────

rpc_call() {
  local port="$1"
  local method="$2"
  local payload="${3:-{}}"

  curl --noproxy '*' -s -X POST "http://localhost:${port}/${method}" \
    -H "Content-Type: application/json" \
    -d "{\"id\":\"dbg-$(date +%s)\",\"source\":\"debug\",\"method\":\"${method}\",\"params\":${payload},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    2>/dev/null
}

require_jq() {
  if ! command -v jq &>/dev/null; then
    echo -e "${RED}[error]${NC} 需要安装 jq: brew install jq"
    exit 1
  fi
}

# ── 辅助函数 ──────────────────────────────────────────────────────────────────

format_duration() {
  local ms="$1"
  if [ -z "$ms" ] || [ "$ms" = "null" ]; then
    echo "running"
    return
  fi
  if [ "$ms" -lt 1000 ]; then
    echo "${ms}ms"
  elif [ "$ms" -lt 60000 ]; then
    echo "$((ms / 1000))s"
  else
    echo "$((ms / 60000))m$((ms % 60000 / 1000))s"
  fi
}

status_color() {
  local s="$1"
  case "$s" in
    running)   echo -e "${BLUE}${s}${NC}" ;;
    completed) echo -e "${GREEN}${s}${NC}" ;;
    failed)    echo -e "${RED}${s}${NC}" ;;
    *)         echo "$s" ;;
  esac
}

# =============================================================================
# 命令：traces - 列出最近的 Trace
# =============================================================================

cmd_traces() {
  require_jq
  local limit="${1:-10}"
  local status_filter="${2:-}"

  local payload="{\"limit\":${limit}}"
  if [ -n "$status_filter" ]; then
    payload="{\"limit\":${limit},\"status\":\"${status_filter}\"}"
  fi

  local raw
  raw=$(rpc_call "$AGENT_PORT" "get_traces" "$payload")

  if ! echo "$raw" | jq -e '.success' &>/dev/null; then
    echo -e "${RED}[error]${NC} Agent (port $AGENT_PORT) 无响应，或返回格式错误"
    echo "$raw"
    return 1
  fi

  local total
  total=$(echo "$raw" | jq -r '.data.total // 0')
  echo -e "${BOLD}${CYAN}── Traces (最近 ${limit}/${total} 条) ──${NC}"
  echo ""

  echo "$raw" | jq -r '.data.traces[] | [
    .trace_id[:8],
    .status,
    (.duration_ms // "null" | tostring),
    .trigger.type,
    (.trigger.summary[:60] | @json),
    (.outcome.summary[:80] // "" | @json)
  ] | @tsv' | while IFS=$'\t' read -r tid status dur ttype summary outcome; do
    local dur_str
    dur_str=$(format_duration "${dur//\"/}")
    local scolor
    scolor=$(status_color "$status")
    printf "  ${DIM}%s${NC}  %-12s  %-8s  %-10s  %s\n" \
      "$tid" "$scolor" "$dur_str" "${ttype//\"/}" "${summary//\"/}"
    if [ -n "${outcome//\"/}" ]; then
      printf "              ${DIM}→ %s${NC}\n" "${outcome//\"/}"
    fi
  done
  echo ""
}

# =============================================================================
# 命令：trace - 显示单个 Trace 的详情（Span 树）
# =============================================================================

cmd_trace() {
  require_jq
  local trace_id="${1:-}"

  if [ -z "$trace_id" ]; then
    # 自动取最新一条
    local raw_list
    raw_list=$(rpc_call "$AGENT_PORT" "get_traces" '{"limit":1}')
    trace_id=$(echo "$raw_list" | jq -r '.data.traces[0].trace_id // empty')
    if [ -z "$trace_id" ]; then
      echo -e "${RED}[error]${NC} 没有 trace，或 Agent 无响应"
      return 1
    fi
    echo -e "${DIM}(使用最新 trace: ${trace_id})${NC}"
  fi

  local raw
  raw=$(rpc_call "$AGENT_PORT" "get_trace" "{\"trace_id\":\"${trace_id}\"}")

  if ! echo "$raw" | jq -e '.success' &>/dev/null; then
    echo -e "${RED}[error]${NC} 获取 trace ${trace_id} 失败"
    echo "$raw"
    return 1
  fi

  local trace
  trace=$(echo "$raw" | jq '.data')

  local status dur trigger_type trigger_src trigger_sum
  status=$(echo "$trace" | jq -r '.status')
  dur=$(echo "$trace" | jq -r '.duration_ms // "null"')
  trigger_type=$(echo "$trace" | jq -r '.trigger.type')
  trigger_src=$(echo "$trace" | jq -r '.trigger.source // ""')
  trigger_sum=$(echo "$trace" | jq -r '.trigger.summary')

  echo ""
  echo -e "${BOLD}${CYAN}── Trace Detail ──${NC}"
  echo -e "  ID:      ${BOLD}${trace_id}${NC}"
  echo -e "  Status:  $(status_color "$status")  ($(format_duration "$dur"))"
  echo -e "  Trigger: [${trigger_type}] ${trigger_sum}"
  [ -n "$trigger_src" ] && echo -e "  Source:  ${trigger_src}"

  local outcome
  outcome=$(echo "$trace" | jq -r '.outcome.summary // ""')
  local outcome_err
  outcome_err=$(echo "$trace" | jq -r '.outcome.error // ""')
  if [ -n "$outcome" ]; then
    echo -e "  Outcome: ${GREEN}${outcome}${NC}"
  fi
  if [ -n "$outcome_err" ]; then
    echo -e "  Error:   ${RED}${outcome_err}${NC}"
  fi

  echo ""
  echo -e "${BOLD}  Spans:${NC}"

  # 输出 Span 树（简单列表，按时间排序）
  echo "$trace" | jq -r '.spans[] | [
    .span_id[:8],
    (.parent_span_id[:8] // "--------"),
    .type,
    .status,
    (.duration_ms // "null" | tostring),
    (
      if .type == "llm_call" then
        "iter=\(.details.iteration) | \(.details.input_summary[:60])"
      elif .type == "tool_call" then
        "\(.details.tool_name): \(.details.input_summary[:50])"
      elif .type == "decision" then
        "\(.details.decision_type): \(.details.summary[:60])"
      elif .type == "context_assembly" then
        "\(.details.context_type) ctx, session=\(.details.session_id[:8] // "?")"
      elif .type == "rpc_call" then
        "\(.details.target_module // "?"):\(.details.method) [\(.details.status_code // "?")]"
      else
        (. | tostring)[:60]
      end
    )
  ] | @tsv' | while IFS=$'\t' read -r sid psid stype sstatus sdur detail; do
    local dur_str
    dur_str=$(format_duration "$sdur")
    local scolor
    scolor=$(status_color "$sstatus")
    printf "    ${DIM}%s${NC}←${DIM}%s${NC}  %-20s  %-12s  %-8s  %s\n" \
      "$sid" "$psid" "$stype" "$scolor" "$dur_str" "$detail"
  done

  echo ""
}

# =============================================================================
# 命令：tasks - 查询 Admin 任务列表
# =============================================================================

cmd_tasks() {
  require_jq
  local status_filter="${1:-}"

  local payload="{\"limit\":20}"
  if [ -n "$status_filter" ]; then
    payload="{\"limit\":20,\"status\":\"${status_filter}\"}"
  fi

  local raw
  raw=$(rpc_call "$ADMIN_PORT" "get_tasks" "$payload")

  if ! echo "$raw" | jq -e '.success' &>/dev/null; then
    echo -e "${RED}[error]${NC} Admin (port $ADMIN_PORT) 无响应"
    echo "$raw"
    return 1
  fi

  local total
  total=$(echo "$raw" | jq -r '.data.total // (.data.tasks | length) // 0')
  echo -e "${BOLD}${CYAN}── Tasks (${total} 条) ──${NC}"
  echo ""

  echo "$raw" | jq -r '.data.tasks[] | [
    .task_id[:8],
    .status,
    .task_type,
    .priority,
    (.title[:50] | @json),
    (.created_at[:19] // "")
  ] | @tsv' 2>/dev/null | while IFS=$'\t' read -r tid status ttype priority title created; do
    local scolor
    scolor=$(status_color "$status")
    printf "  ${DIM}%s${NC}  %-14s  %-12s  %-8s  %s  ${DIM}%s${NC}\n" \
      "$tid" "$scolor" "${ttype}" "${priority}" "${title//\"/}" "${created}"
  done
  echo ""
}

# =============================================================================
# 命令：health - 检查各模块健康状态
# =============================================================================

cmd_health() {
  require_jq

  echo -e "${BOLD}${CYAN}── Module Health ──${NC}"
  echo ""

  check_module() {
    local name="$1"
    local port="$2"
    local raw
    raw=$(rpc_call "$port" "health" '{}')
    if echo "$raw" | jq -e '.success' &>/dev/null; then
      local status
      status=$(echo "$raw" | jq -r '.data.status // "unknown"')
      case "$status" in
        healthy)  echo -e "  ${GREEN}●${NC} ${name} (port ${port}): ${GREEN}${status}${NC}" ;;
        degraded) echo -e "  ${YELLOW}●${NC} ${name} (port ${port}): ${YELLOW}${status}${NC}" ;;
        *)        echo -e "  ${RED}●${NC} ${name} (port ${port}): ${RED}${status}${NC}" ;;
      esac
    else
      echo -e "  ${RED}●${NC} ${name} (port ${port}): ${RED}unreachable${NC}"
    fi
  }

  check_module "Module Manager" "$MM_PORT"
  check_module "Admin (RPC)"    "$ADMIN_PORT"
  check_module "Agent"          "$AGENT_PORT"

  echo ""
}

# =============================================================================
# 命令：logs - 查看 SDK Runner 日志（最近 N 行）
# =============================================================================

cmd_logs() {
  local lines="${1:-50}"
  local log_file="${CRABOT_HOME:-$(cd "$(dirname "$0")/.." && pwd)}/data/agent/sdk-runner-debug.log"

  echo -e "${BOLD}${CYAN}── SDK Runner Log (最近 ${lines} 行) ──${NC}"
  echo -e "${DIM}  ${log_file}${NC}"
  echo ""

  if [ -f "$log_file" ]; then
    tail -n "$lines" "$log_file"
  else
    echo -e "${YELLOW}  日志文件不存在: ${log_file}${NC}"
    echo -e "${DIM}  提示：Agent 需要运行过至少一次才会生成日志${NC}"
  fi
  echo ""
}

# =============================================================================
# 命令：modules - 列出 Module Manager 中注册的模块
# =============================================================================

cmd_modules() {
  require_jq

  local raw
  raw=$(rpc_call "$MM_PORT" "list_modules" '{}')

  echo -e "${BOLD}${CYAN}── Registered Modules ──${NC}"
  echo ""

  if echo "$raw" | jq -e '.success' &>/dev/null; then
    echo "$raw" | jq -r '
      .data.modules[] |
      "  \(.module_id)  type=\(.module_type)  port=\(.port // "?")  status=\(.status // "?")"
    ' 2>/dev/null || echo "$raw" | jq '.data'
  else
    echo -e "${RED}[error]${NC} Module Manager 无响应或不支持 list_modules"
    echo "$raw"
  fi
  echo ""
}

# =============================================================================
# 命令：watch - 实时监控（每 3 秒刷新一次 trace 列表）
# =============================================================================

cmd_watch() {
  echo -e "${DIM}监控模式，每 3 秒刷新。Ctrl+C 退出。${NC}"
  while true; do
    clear
    echo -e "${DIM}$(date)${NC}"
    cmd_health
    cmd_traces 5
    sleep 3
  done
}

# =============================================================================
# 命令：help
# =============================================================================

cmd_help() {
  echo ""
  echo -e "${BOLD}Crabot Agent 调试脚本${NC}"
  echo ""
  echo -e "  ${BOLD}用法:${NC} $0 <命令> [参数...]"
  echo ""
  echo -e "  ${BOLD}命令:${NC}"
  echo -e "    ${CYAN}traces${NC}  [limit] [status]   列出最近的 Trace（默认 10 条）"
  echo -e "    ${CYAN}trace${NC}   [trace_id]          显示单个 Trace 详情（默认最新一条）"
  echo -e "    ${CYAN}tasks${NC}   [status]            列出 Admin 任务"
  echo -e "    ${CYAN}health${NC}                      检查各模块健康状态"
  echo -e "    ${CYAN}logs${NC}    [lines]             查看 SDK Runner 日志（默认 50 行）"
  echo -e "    ${CYAN}modules${NC}                     列出 MM 注册的模块"
  echo -e "    ${CYAN}watch${NC}                       实时监控模式"
  echo ""
  echo -e "  ${BOLD}环境变量（覆盖默认端口）:${NC}"
  echo -e "    CRABOT_MM_PORT    Module Manager 端口（默认 19000）"
  echo -e "    CRABOT_ADMIN_PORT Admin RPC 端口（默认 19001）"
  echo -e "    CRABOT_AGENT_PORT Agent 端口（默认 19005）"
  echo ""
  echo -e "  ${BOLD}示例:${NC}"
  echo -e "    $0 traces              # 列出最近 10 条 trace"
  echo -e "    $0 traces 20 failed    # 列出最近 20 条失败的 trace"
  echo -e "    $0 trace               # 显示最新 trace 详情"
  echo -e "    $0 trace abc12345...   # 显示指定 trace 详情"
  echo -e "    $0 tasks executing     # 列出进行中的任务"
  echo -e "    $0 logs 100            # 查看最近 100 行日志"
  echo -e "    CRABOT_AGENT_PORT=19006 $0 traces   # 指定 Agent 端口"
  echo ""
  echo -e "  ${DIM}详细说明：$(dirname "$0")/../docs/agent-debugging.md${NC}"
  echo ""
}

# =============================================================================
# 入口
# =============================================================================

CMD="${1:-help}"
shift 2>/dev/null || true

case "$CMD" in
  traces)  cmd_traces "$@" ;;
  trace)   cmd_trace "$@" ;;
  tasks)   cmd_tasks "$@" ;;
  health)  cmd_health "$@" ;;
  logs)    cmd_logs "$@" ;;
  modules) cmd_modules "$@" ;;
  watch)   cmd_watch "$@" ;;
  help|--help|-h) cmd_help ;;
  *)
    echo -e "${RED}[error]${NC} 未知命令: $CMD"
    cmd_help
    exit 1
    ;;
esac
