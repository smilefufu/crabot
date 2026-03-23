#!/bin/bash

# Crabot Dev - 开发模式启动脚本
# 用法: ./dev.sh          构建 + 启动 LiteLLM + Module Manager（前台，含 Vite）
#       ./dev.sh stop      停止所有开发服务
#       ./dev.sh build     仅构建，不启动

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DATA_DIR="${DATA_DIR:-$SCRIPT_DIR/data}"
LITELLM_PORT="${LITELLM_PORT:-4000}"
LITELLM_DIR="${LITELLM_DIR:-$DATA_DIR/litellm}"
LITELLM_CONFIG="${LITELLM_CONFIG:-$LITELLM_DIR/config.yaml}"
MEMORY_DIR="${MEMORY_DIR:-$SCRIPT_DIR/crabot-memory}"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[dev]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[dev]${NC} $1"; }
log_error() { echo -e "${RED}[dev]${NC} $1"; }
log_dim()   { echo -e "${DIM}$1${NC}"; }

# ── 环境变量 ──────────────────────────────────────────────

load_env() {
  for f in "$DATA_DIR/admin/.env" "$SCRIPT_DIR/.env"; do
    if [ -f "$f" ]; then
      while IFS= read -r line; do
        line="${line%%#*}"
        line="$(echo "$line" | xargs)"
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

# ── 构建 ──────────────────────────────────────────────────

build_all() {
  log_info "构建 TypeScript 模块..."

  local fail=0
  for mod in crabot-core crabot-admin crabot-agent crabot-channel-host; do
    if [ ! -d "$SCRIPT_DIR/$mod" ]; then
      continue
    fi
    # dev 模式下 Admin 用 tsx --watch 直接跑源码，不需要编译
    if [ "$mod" = "crabot-admin" ] && [ "${CRABOT_DEV:-}" = "true" ]; then
      log_dim "  $mod (跳过，dev 模式用 tsx)"
      continue
    fi
    log_dim "  $mod"
    (cd "$SCRIPT_DIR/$mod" && npm run build 2>&1 | sed 's/^/    /') || {
      log_error "$mod 构建失败"
      fail=1
    }
  done

  if [ "$fail" -eq 1 ]; then
    exit 1
  fi

  # node-pty 的 spawn-helper 在 macOS 上需要可执行权限
  local spawn_helper="$SCRIPT_DIR/crabot-admin/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
  if [ -f "$spawn_helper" ] && [ ! -x "$spawn_helper" ]; then
    chmod +x "$spawn_helper"
    log_info "已修复 node-pty spawn-helper 权限"
  fi

  log_info "构建完成"
}

# ── LiteLLM 补丁 ──────────────────────────────────────────

apply_litellm_patches() {
  local litellm_site
  litellm_site=$(python3 -c "import litellm, os; print(os.path.dirname(litellm.__file__))" 2>/dev/null) || {
    log_warn "无法定位 LiteLLM 安装路径，跳过补丁"
    return 0
  }

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

# ── LiteLLM ───────────────────────────────────────────────

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
    log_dim "  安装: pip install -i https://pypi.org/simple/ 'litellm[proxy]'"
    return 0
  fi

  # 检查 LiteLLM 版本，若低于最低要求自动升级
  LITELLM_MIN="1.82.0"
  LITELLM_CUR=$(pip show litellm 2>/dev/null | grep Version | awk '{print $2}')
  if [ -n "$LITELLM_CUR" ] && [ "$(printf '%s\n' "$LITELLM_MIN" "$LITELLM_CUR" | sort -V | head -1)" != "$LITELLM_MIN" ]; then
    log_warn "LiteLLM 版本过低 ($LITELLM_CUR < $LITELLM_MIN)，升级中..."
    pip install -i https://pypi.org/simple/ -U 'litellm[proxy]' -q || log_warn "LiteLLM 升级失败，继续使用当前版本"
  fi

  # 应用 bug 修复补丁（升级后需重新应用）
  apply_litellm_patches

  log_info "启动 LiteLLM..."
  if [ -z "$LITELLM_MASTER_KEY" ]; then
    export LITELLM_MASTER_KEY="sk-litellm-$(openssl rand -hex 16 2>/dev/null || echo default)"
  fi

  # LiteLLM 不走代理
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

# ── Memory 依赖同步 ──────────────────────────────────────

sync_memory_deps() {
  if [ ! -d "$MEMORY_DIR" ]; then
    return 0
  fi

  if ! command -v uv &>/dev/null; then
    log_warn "uv 未安装，跳过 Memory 依赖同步"
    log_dim "  安装: curl -LsSf https://astral.sh/uv/install.sh | sh"
    return 0
  fi

  log_info "同步 Memory 依赖..."
  (cd "$MEMORY_DIR" && uv sync 2>/dev/null) || {
    log_warn "Memory 依赖同步失败"
    return 0
  }

  mkdir -p "$DATA_DIR/memory"
}

# ── 停止 ──────────────────────────────────────────────────

stop_all() {
  log_info "停止开发服务..."

  # 优雅关闭 Module Manager（会级联关闭所有子模块，含 Vite）
  curl --noproxy '*' -s -X POST http://localhost:19000/shutdown \
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

  # 杀掉残留进程（MM 级联关闭可能未完全生效）
  pkill -f "crabot-core/dist/main.js" 2>/dev/null || true
  pkill -f "crabot-admin/dist/main.js" 2>/dev/null || true
  pkill -f "crabot-agent/dist/main.js" 2>/dev/null || true
  pkill -f "vite.*crabot-admin/web" 2>/dev/null || true

  # 杀掉 LiteLLM
  pkill -f "litellm.*--config.*$LITELLM_CONFIG" 2>/dev/null || true
  if [ -f "$DATA_DIR/litellm/litellm.pid" ]; then
    kill "$(cat "$DATA_DIR/litellm/litellm.pid")" 2>/dev/null || true
    rm -f "$DATA_DIR/litellm/litellm.pid"
  fi

  # 兜底释放所有已知端口
  for port in 19000 19001 3000 "$LITELLM_PORT"; do
    local pid
    pid=$(lsof -ti :"$port" 2>/dev/null) || true
    if [ -n "$pid" ]; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done

  log_info "已停止"
}

# ── 启动 ──────────────────────────────────────────────────

start() {
  export CRABOT_DEV=true
  load_env
  mkdir -p "$DATA_DIR/admin" "$DATA_DIR/agent" "$DATA_DIR/litellm" "$DATA_DIR/memory"

  # 1. LiteLLM（冷启动，Memory priority=5 比 Admin priority=10 先启动，需要 LiteLLM 就绪）
  start_litellm

  # 2. 准备 Memory 依赖
  sync_memory_deps

  # 3. 构建（Admin 跳过，用 tsx --watch 直接跑源码）
  build_all

  # 4. Module Manager（前台 exec，会自动拉起 Memory + Admin + Agent + Vite）
  log_info "启动 Module Manager..."
  cd "$SCRIPT_DIR/crabot-core"
  exec node dist/main.js
}

# ── 主入口 ────────────────────────────────────────────────

case "${1:-start}" in
  start)   start ;;
  stop)    stop_all ;;
  build)   load_env && build_all ;;
  *)
    echo "用法: $0 [start|stop|build]"
    echo ""
    echo "  start  启动开发环境（默认）"
    echo "  stop   停止所有开发服务"
    echo "  build  仅构建 TypeScript"
    exit 1
    ;;
esac
