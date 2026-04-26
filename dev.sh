#!/bin/bash

# Crabot Dev - 开发模式启动脚本
# 用法: ./dev.sh          构建 + 启动 Module Manager（前台，含 Vite）
#       ./dev.sh stop      停止所有开发服务
#       ./dev.sh build     仅构建，不启动

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# PATH 兜底（见 scripts/lib.sh 同名逻辑）：脚本是非交互 shell，不会 source
# ~/.bashrc，若用户 onboard 后在当前 shell 直接跑 dev.sh，uv 会找不到。
if [ -d "$HOME/.local/bin" ]; then
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) : ;;
    *) export PATH="$HOME/.local/bin:$PATH" ;;
  esac
fi

PORT_OFFSET="${CRABOT_PORT_OFFSET:-0}"
MM_PORT=$((19000 + PORT_OFFSET))
ADMIN_RPC_PORT=$((19001 + PORT_OFFSET))
ADMIN_WEB_PORT=$((3000 + PORT_OFFSET))

if [ "$PORT_OFFSET" -gt 0 ]; then
  DATA_DIR="${DATA_DIR:-$SCRIPT_DIR/data-$PORT_OFFSET}"
else
  DATA_DIR="${DATA_DIR:-$SCRIPT_DIR/data}"
fi
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
  for f in "$SCRIPT_DIR/.env"; do
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

  # crabot-shared 必须先编译
  if [ -d "$SCRIPT_DIR/crabot-shared" ]; then
    log_dim "  crabot-shared"
    (cd "$SCRIPT_DIR/crabot-shared" && pnpm run build 2>&1 | sed 's/^/    /') || {
      log_error "crabot-shared 构建失败"
      exit 1
    }
  fi

  local fail=0
  for mod in crabot-core crabot-admin crabot-agent crabot-channel-host crabot-channel-wechat crabot-channel-telegram; do
    if [ ! -d "$SCRIPT_DIR/$mod" ]; then
      continue
    fi
    # dev 模式下 Admin 用 tsx --watch 直接跑源码，不需要编译
    if [ "$mod" = "crabot-admin" ] && [ "${CRABOT_DEV:-}" = "true" ]; then
      log_dim "  $mod (跳过，dev 模式用 tsx)"
      continue
    fi
    log_dim "  $mod"
    (cd "$SCRIPT_DIR/$mod" && pnpm run build 2>&1 | sed 's/^/    /') || {
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

# ── Scrapling ─────────────────────────────────────────────

check_scrapling() {
  local scrapling_min="0.4.4"
  if ! command -v scrapling &>/dev/null; then
    log_info "安装 Scrapling（Browser Use 功能需要）..."
    pip install -i https://pypi.org/simple/ "scrapling[ai]" -q || {
      log_warn "Scrapling 安装失败，Browser Use 功能不可用"
      return 1
    }
    log_info "Scrapling 已安装"
  fi

  # 检查版本
  local cur
  cur=$(pip show scrapling 2>/dev/null | grep Version | awk '{print $2}')
  if [ -n "$cur" ] && [ "$(printf '%s\n' "$scrapling_min" "$cur" | sort -V | head -1)" != "$scrapling_min" ]; then
    log_warn "Scrapling 版本过低 ($cur < $scrapling_min)，升级中..."
    pip install -i https://pypi.org/simple/ -U "scrapling[ai]" -q || log_warn "Scrapling 升级失败，继续使用当前版本"
  fi
  return 0
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
  curl --noproxy '*' -s -X POST "http://localhost:$MM_PORT/shutdown" \
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

  # 清理 Crabot 管理的 Chrome 实例
  if [ -f "$DATA_DIR/browser/chrome.pid" ]; then
    kill "$(cat "$DATA_DIR/browser/chrome.pid")" 2>/dev/null || true
    rm -f "$DATA_DIR/browser/chrome.pid"
  fi

  # 兜底释放所有已知端口
  for port in "$MM_PORT" "$ADMIN_RPC_PORT" "$ADMIN_WEB_PORT"; do
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
  mkdir -p "$DATA_DIR/admin" "$DATA_DIR/agent" "$DATA_DIR/memory"

  check_scrapling || true  # 非阻塞，仅提示

  # 1. 准备 Memory 依赖
  sync_memory_deps

  # 2. 构建（Admin 跳过，用 tsx --watch 直接跑源码）
  build_all

  # 3. macOS 权限预检（computer-use MCP 需要屏幕录制 + 辅助功能权限）
  if [ "$(uname -s)" = "Darwin" ]; then
    local mcp_config="$DATA_DIR/admin/mcp-servers.json"
    if [ -f "$mcp_config" ] && node -e "
      const cfg = require('$mcp_config');
      process.exit(cfg.find(s => s.name === 'computer-use' && s.enabled) ? 0 : 1);
    " 2>/dev/null; then
      log_info "检查 computer-use 权限..."
      local tmp_ss="/tmp/.crabot-permission-check.png"
      if node -e "try{require('child_process').execFileSync('screencapture',['-x','-t','png','$tmp_ss'],{timeout:5000});process.exit(0)}catch{process.exit(1)}" 2>/dev/null; then
        log_info "  屏幕录制 ✓"
      else
        log_warn "  屏幕录制权限未授予 node — 请在系统弹窗中允许"
      fi
      rm -f "$tmp_ss"
      if node -e "try{require('child_process').execFileSync('osascript',['-e','tell application \"System Events\" to return name of first process'],{timeout:5000});process.exit(0)}catch{process.exit(1)}" 2>/dev/null; then
        log_info "  辅助功能 ✓"
      else
        log_warn "  辅助功能权限未授予 node — 请在系统弹窗中允许"
      fi
    fi
  fi

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
