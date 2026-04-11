#!/bin/bash

# Crabot 共享函数库
# 由 crabot 主入口 source，提供日志、环境检测、构建等公共函数
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

# ── Scrapling ─────────────────────────────────────────────

check_scrapling() {
  local scrapling_required="0.4.4"
  if ! command -v scrapling &>/dev/null; then
    log_info "安装 Scrapling（Browser Use 功能需要）..."
    uv tool install "scrapling[ai]" -q 2>/dev/null \
      || pip install -i https://pypi.org/simple/ "scrapling[ai]" -q \
      || {
        log_warn "Scrapling 安装失败，Browser Use 功能不可用"
        return 1
      }
    log_info "Scrapling 已安装"
  fi

  # 检查版本
  local cur
  cur=$(pip show scrapling 2>/dev/null | grep Version | awk '{print $2}')
  if [ -n "$cur" ] && [ "$cur" != "$scrapling_required" ]; then
    log_warn "Scrapling 版本不匹配 ($cur != $scrapling_required)，重装中..."
    uv tool install "scrapling[ai]==$scrapling_required" -q 2>/dev/null \
      || pip install -i https://pypi.org/simple/ "scrapling[ai]==$scrapling_required" -q \
      || log_warn "Scrapling 重装失败，继续使用当前版本"
  fi
  return 0
}

# ── Node.js 依赖 ────────────────────────────────────────

sync_node_deps() {
  log_info "同步 Node.js 依赖..."

  for mod in crabot-shared crabot-core crabot-admin crabot-agent crabot-channel-host crabot-channel-wechat crabot-channel-telegram; do
    if [ ! -d "$CRABOT_HOME/$mod" ]; then
      continue
    fi
    log_dim "  $mod"
    (cd "$CRABOT_HOME/$mod" && npm install 2>&1 | tail -1) || {
      log_error "$mod 依赖安装失败"
      return 1
    }
  done

  # crabot-admin/web 前端依赖
  if [ -d "$CRABOT_HOME/crabot-admin/web" ]; then
    log_dim "  crabot-admin/web"
    (cd "$CRABOT_HOME/crabot-admin/web" && npm install 2>&1 | tail -1) || {
      log_error "crabot-admin/web 依赖安装失败"
      return 1
    }
  fi
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

  # crabot-shared 必须先编译（其他模块依赖它）
  if [ -d "$CRABOT_HOME/crabot-shared" ]; then
    log_dim "  crabot-shared"
    local build_log
    build_log="$(cd "$CRABOT_HOME/crabot-shared" && npm run build 2>&1)" || {
      echo "$build_log" | sed 's/^/    /'
      log_error "crabot-shared 构建失败"
      return 1
    }
  fi

  local fail=0
  for mod in crabot-core crabot-admin crabot-agent crabot-channel-host crabot-channel-wechat crabot-channel-telegram; do
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

# ── macOS 权限预检 ──────────────────────────────────────

# computer-use MCP 需要 macOS 的「屏幕录制」和「辅助功能」权限。
# 权限绑定到 node 二进制，必须通过 node 触发弹窗。
# 此函数在启动时预检，避免运行时首次调用工具才弹窗。
precheck_macos_permissions() {
  [ "$(detect_os)" = "macos" ] || return 0

  # 检查 computer-use 是否启用
  local mcp_config="$DATA_DIR/admin/mcp-servers.json"
  if [ ! -f "$mcp_config" ]; then
    return 0
  fi
  if ! node -e "
    const cfg = require('$mcp_config');
    const cu = cfg.find(s => s.name === 'computer-use' && s.enabled);
    process.exit(cu ? 0 : 1);
  " 2>/dev/null; then
    return 0
  fi

  log_info "检查 computer-use 权限..."

  local tmp_screenshot="/tmp/.crabot-permission-check.png"
  local need_grant=false

  # 1. 屏幕录制权限：通过 node 调用 screencapture
  if ! node -e "
    const { execFileSync } = require('child_process');
    try {
      execFileSync('screencapture', ['-x', '-t', 'png', '$tmp_screenshot'], { timeout: 5000 });
      process.exit(0);
    } catch { process.exit(1); }
  " 2>/dev/null; then
    need_grant=true
    log_warn "屏幕录制权限未授予 node ($(which node))"
    log_warn "  请在弹出的系统对话框中允许，或前往："
    log_warn "  系统设置 → 隐私与安全性 → 屏幕录制 → 允许 node"
  else
    log_success "屏幕录制权限已就绪"
  fi
  rm -f "$tmp_screenshot"

  # 2. 辅助功能权限：通过 node 调用 osascript
  if ! node -e "
    const { execFileSync } = require('child_process');
    try {
      execFileSync('osascript', ['-e', 'tell application \"System Events\" to return name of first process'], { timeout: 5000 });
      process.exit(0);
    } catch { process.exit(1); }
  " 2>/dev/null; then
    need_grant=true
    log_warn "辅助功能权限未授予 node ($(which node))"
    log_warn "  请在弹出的系统对话框中允许，或前往："
    log_warn "  系统设置 → 隐私与安全性 → 辅助功能 → 允许 node"
  else
    log_success "辅助功能权限已就绪"
  fi

  if [ "$need_grant" = true ]; then
    log_warn "授予权限后可能需要重启终端或重新运行 ./crabot start"
  fi
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

  # 清理 Crabot 管理的 Chrome 实例
  if [ -f "$DATA_DIR/browser/chrome.pid" ]; then
    kill "$(cat "$DATA_DIR/browser/chrome.pid")" 2>/dev/null || true
    rm -f "$DATA_DIR/browser/chrome.pid"
  fi

  # 等待 SIGTERM 生效
  sleep 2

  # 兜底释放所有已知端口（先 SIGTERM，再 SIGKILL）
  local offset="${CRABOT_PORT_OFFSET:-0}"
  local ports=("$((19000 + offset))" "$((19001 + offset))" "$((3000 + offset))")
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
