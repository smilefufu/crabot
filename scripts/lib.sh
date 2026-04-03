#!/bin/bash

# Crabot 共享函数库
# 由 crabot 主入口 source，提供日志、环境检测、LiteLLM、构建等公共函数
# 本文件为纯函数库，不产生副作用

# ── 颜色 ──────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── 日志 ──────────────────────────────────────────────────

log_info()    { echo -e "${GREEN}[crabot]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[crabot]${NC} $1"; }
log_error()   { echo -e "${RED}[crabot]${NC} $1"; }
log_success() { echo -e "${GREEN}[crabot]${NC} ${GREEN}✓${NC} $1"; }
log_section() { echo -e "\n${BOLD}${CYAN}── $1 ──${NC}\n"; }
log_dim()     { echo -e "${DIM}$1${NC}"; }

# ── OS 检测 ───────────────────────────────────────────────

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)  echo "linux" ;;
    *)      echo "unknown" ;;
  esac
}

# macOS 和 Linux 的 sed -i 语法不同
sed_inplace() {
  if [ "$(detect_os)" = "macos" ]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# ── 版本比较 ──────────────────────────────────────────────

# version_ge $1 $2 → $1 >= $2 ? 0 : 1
# 可移植实现（macOS BSD sort 不支持 -V）
version_ge() {
  local IFS=.
  local i ver1=($(echo "$1" | tr -d '[:space:]')) ver2=($(echo "$2" | tr -d '[:space:]'))
  for ((i=0; i<${#ver2[@]}; i++)); do
    if ((10#${ver1[i]:-0} > 10#${ver2[i]:-0})); then
      return 0
    elif ((10#${ver1[i]:-0} < 10#${ver2[i]:-0})); then
      return 1
    fi
  done
  return 0
}

# ── 用户确认 ──────────────────────────────────────────────

# confirm "提示文字" → 用户输入 y/Y 返回 0
# NON_INTERACTIVE=true 时自动返回 0
confirm() {
  if [ "${NON_INTERACTIVE:-}" = "true" ]; then
    return 0
  fi
  printf "${YELLOW}[crabot]${NC} %s [Y/n] " "$1"
  read -r answer
  case "$answer" in
    [nN]*) return 1 ;;
    *)     return 0 ;;
  esac
}

# ── 环境变量 ──────────────────────────────────────────────

load_env() {
  for f in "$DATA_DIR/admin/.env" "$CRABOT_HOME/.env"; do
    if [ -f "$f" ]; then
      while IFS= read -r line; do
        line="${line%%#*}"
        # 去除首尾空白（不用 xargs，避免 xargs 吃掉引号和反斜杠）
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"
        if [ -n "$line" ]; then
          key="${line%%=*}"
          val="${line#*=}"
          if [ -z "${!key}" ]; then
            export "$key=$val"
          fi
        fi
      done < "$f"
    fi
  done

  export CRABOT_ADMIN_PASSWORD="${CRABOT_ADMIN_PASSWORD:-admin123}"
  export CRABOT_JWT_SECRET="${CRABOT_JWT_SECRET:-$(openssl rand -hex 32 2>/dev/null || echo dev-secret)}"
  export DATA_DIR="$DATA_DIR"
}

# ── LiteLLM ──────────────────────────────────────────────

apply_litellm_patches() {
  local litellm_site
  # 优先用 uv tool 的 venv 中的 python（litellm 通过 uv tool install 安装）
  local uv_litellm_python="$HOME/.local/share/uv/tools/litellm/bin/python3"
  if [ -x "$uv_litellm_python" ]; then
    litellm_site=$("$uv_litellm_python" -c "import litellm, os; print(os.path.dirname(litellm.__file__))" 2>/dev/null)
  fi
  if [ -z "$litellm_site" ]; then
    litellm_site=$(python3 -c "import litellm, os; print(os.path.dirname(litellm.__file__))" 2>/dev/null)
  fi
  if [ -z "$litellm_site" ]; then
    log_warn "无法定位 LiteLLM 安装路径，跳过补丁"
    return 0
  fi

  local tf="$litellm_site/llms/anthropic/experimental_pass_through/adapters/transformation.py"
  local oa="$litellm_site/llms/openai/openai.py"

  # 补丁 1：移除 thinking_blocks 字段（Anthropic 专有，非 Anthropic provider 不识别）
  if [ -f "$tf" ] && ! grep -q 'thinking_blocks 是 Anthropic 专有字段' "$tf" 2>/dev/null; then
    python3 - "$tf" << 'PYEOF'
import sys, re
path = sys.argv[1]
with open(path) as f:
    content = f.read()
patched = re.sub(
    r'\n(\s+)if len\(thinking_blocks\) > 0:\n\1    assistant_message\["thinking_blocks"\] = thinking_blocks\n',
    '\n\\1# thinking_blocks 是 Anthropic 专有字段，不发给非 Anthropic provider\n\\1# （OpenAI/OpenRouter 等不认识此字段，会返回 400）\n',
    content
)
if patched == content:
    print("WARN: patch1 pattern not found, skipping", file=sys.stderr)
    sys.exit(0)
with open(path, 'w') as f:
    f.write(patched)
print("patch1 applied")
PYEOF
    log_info "LiteLLM 补丁 1/2 已应用（thinking_blocks 过滤）"
  fi

  # 补丁 2：为缺少 content 的 assistant 消息补充 content: None
  if [ -f "$oa" ] && ! grep -q '确保 assistant 消息始终包含 content 字段' "$oa" 2>/dev/null; then
    python3 - "$oa" << 'PYEOF'
import sys, re
path = sys.argv[1]
with open(path) as f:
    content = f.read()
insertion = (
    '        # 确保 assistant 消息始终包含 content 字段\n'
    '        # 部分 provider（如 StepFun）要求 content 显式存在，OpenAI SDK 序列化会过滤 None\n'
    '        _messages = data.get("messages")\n'
    '        if isinstance(_messages, list):\n'
    '            for _m in _messages:\n'
    '                if isinstance(_m, dict) and _m.get("role") == "assistant" and "content" not in _m:\n'
    '                    _m["content"] = None\n'
)
patched = re.sub(
    r'(\n        start_time = time\.time\(\)\n)',
    '\n' + insertion + r'\1',
    content,
    count=1
)
if patched == content:
    print("WARN: patch2 pattern not found, skipping", file=sys.stderr)
    sys.exit(0)
with open(path, 'w') as f:
    f.write(patched)
print("patch2 applied")
PYEOF
    log_info "LiteLLM 补丁 2/2 已应用（assistant content 字段）"
  fi
}

check_litellm() {
  curl --noproxy '*' -s -o /dev/null -w '%{http_code}' \
    "http://localhost:$LITELLM_PORT/health" 2>/dev/null | grep -qE '200|401'
}

start_litellm() {
  if check_litellm; then
    log_info "LiteLLM 已在运行 (port $LITELLM_PORT)"
    return 0
  fi

  if ! command -v litellm &>/dev/null; then
    log_warn "LiteLLM 未安装，跳过（LLM 功能不可用）"
    log_dim "  安装: uv tool install 'litellm[proxy]'"
    return 0
  fi

  # 检查 LiteLLM 版本，必须严格为 1.82.6（高版本存在安全投毒问题）
  local litellm_required="1.82.6"
  local litellm_cur
  litellm_cur=$(litellm --version 2>/dev/null | awk '{print $NF}' | tr -d '\r\n')
  if [ -n "$litellm_cur" ] && [ "$litellm_cur" != "$litellm_required" ]; then
    log_warn "LiteLLM 版本不正确 ($litellm_cur != $litellm_required)，重装为安全版本..."
    uv tool uninstall litellm -q 2>/dev/null || true
    uv tool install 'litellm[proxy]==1.82.6' -q || log_warn "LiteLLM 重装失败，继续使用当前版本"
  fi

  apply_litellm_patches

  log_info "启动 LiteLLM..."
  mkdir -p "$DATA_DIR/litellm"

  # 首次启动时生成默认配置（后续由 Admin 动态覆盖）
  if [ ! -f "$LITELLM_CONFIG" ]; then
    cat > "$LITELLM_CONFIG" << 'CFGEOF'
# LiteLLM Proxy 配置（初始空配置，由 crabot-admin 动态管理）
model_list: []

litellm_settings:
  drop_params: true
  set_verbose: false
CFGEOF
    log_info "已生成 LiteLLM 默认配置: $LITELLM_CONFIG"
  fi

  if [ -z "$LITELLM_MASTER_KEY" ]; then
    export LITELLM_MASTER_KEY="sk-litellm-$(openssl rand -hex 16 2>/dev/null || echo default)"
  fi

  (
    unset all_proxy ALL_PROXY http_proxy HTTP_PROXY https_proxy HTTPS_PROXY
    export no_proxy="*"
    export LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES=true
    litellm --config "$LITELLM_CONFIG" --port "$LITELLM_PORT" &
    echo $! > "$DATA_DIR/litellm/litellm.pid"
  )

  for _ in $(seq 1 20); do
    if check_litellm; then
      log_info "LiteLLM 就绪"
      return 0
    fi
    sleep 1
  done

  log_warn "LiteLLM 启动超时，继续..."
}

# ── Memory 依赖 ──────────────────────────────────────────

sync_memory_deps() {
  local memory_dir="$CRABOT_HOME/crabot-memory"
  if [ ! -d "$memory_dir" ]; then
    return 0
  fi

  if ! command -v uv &>/dev/null; then
    log_warn "uv 未安装，跳过 Memory 依赖同步"
    log_dim "  安装: curl -LsSf https://astral.sh/uv/install.sh | sh"
    return 0
  fi

  log_info "同步 Memory 依赖..."
  (cd "$memory_dir" && uv sync 2>/dev/null) || {
    log_warn "Memory 依赖同步失败"
    return 0
  }

  mkdir -p "$DATA_DIR/memory"
}

# ── 构建 ──────────────────────────────────────────────────

build_all_modules() {
  log_info "构建 TypeScript 模块..."

  local fail=0
  for mod in crabot-core crabot-admin crabot-agent crabot-channel-host crabot-channel-wechat; do
    if [ ! -d "$CRABOT_HOME/$mod" ]; then
      continue
    fi
    log_dim "  $mod"
    local build_log
    build_log="$(cd "$CRABOT_HOME/$mod" && npm run build 2>&1)" || {
      echo "$build_log" | sed 's/^/    /'
      log_error "$mod 构建失败"
      fail=1
    }
  done

  if [ "$fail" -eq 1 ]; then
    return 1
  fi

  # node-pty 的 spawn-helper 在 macOS 上需要可执行权限
  local spawn_helper="$CRABOT_HOME/crabot-admin/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
  if [ -f "$spawn_helper" ] && [ ! -x "$spawn_helper" ]; then
    chmod +x "$spawn_helper"
    log_info "已修复 node-pty spawn-helper 权限"
  fi

  log_info "TypeScript 构建完成"
}

build_frontend() {
  log_info "构建前端..."
  local build_log
  build_log="$(cd "$CRABOT_HOME/crabot-admin/web" && npm run build 2>&1)" || {
    echo "$build_log" | sed 's/^/    /'
    log_error "前端构建失败"
    return 1
  }
  log_info "前端构建完成"
}

# ── 进程管理 ──────────────────────────────────────────────

stop_all_services() {
  log_info "停止 Crabot 服务..."

  # 优雅关闭 Module Manager（会级联关闭所有子模块）
  local mm_port=$((19000 + ${CRABOT_PORT_OFFSET:-0}))
  curl --noproxy '*' -s -X POST "http://localhost:$mm_port/shutdown" \
    -H "Content-Type: application/json" -d '{}' 2>/dev/null || true

  # 等待 MM 进程真正退出（最多 15 秒），确保 Admin saveData() 完成
  local waited=0
  while pgrep -f "crabot-core/dist/main.js" >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge 15 ]; then
      log_warn "Module Manager 未在 15 秒内退出，强制终止"
      break
    fi
  done

  # 杀掉残留进程（SIGTERM，留给 saveData 时间）
  pkill -f "node.*crabot-core/dist/main.js" 2>/dev/null || true
  pkill -f "node.*crabot-admin/dist/main.js" 2>/dev/null || true
  pkill -f "node.*crabot-agent/dist/main.js" 2>/dev/null || true

  # 杀掉 LiteLLM
  pkill -f "litellm.*--config.*$LITELLM_CONFIG" 2>/dev/null || true
  if [ -f "$DATA_DIR/litellm/litellm.pid" ]; then
    kill "$(cat "$DATA_DIR/litellm/litellm.pid")" 2>/dev/null || true
    rm -f "$DATA_DIR/litellm/litellm.pid"
  fi

  # 等待 SIGTERM 生效
  sleep 2

  # 兜底释放所有已知端口（先 SIGTERM，再 SIGKILL）
  local offset="${CRABOT_PORT_OFFSET:-0}"
  local ports=("$((19000 + offset))" "$((19001 + offset))" "$((3000 + offset))" "$LITELLM_PORT")
  for port in "${ports[@]}"; do
    lsof -ti :"$port" 2>/dev/null | while read -r pid; do
      if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null || true
      fi
    done
  done
  sleep 1
  for port in "${ports[@]}"; do
    lsof -ti :"$port" 2>/dev/null | while read -r pid; do
      if [ -n "$pid" ]; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  done

  log_info "已停止"
}
