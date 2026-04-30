#!/bin/bash
set -e

# Crabot 安装脚本
# 用法:
#   远程安装: curl -fsSL <url>/install.sh | bash
#   源码安装: ./install.sh --from-source

CRABOT_VERSION="${CRABOT_VERSION:-latest}"
INSTALL_DIR="${CRABOT_INSTALL_DIR:-$HOME/.crabot}"
REQUIRED_NODE_VERSION="22.14.0"
FROM_SOURCE=false

# 解析参数
for arg in "$@"; do
  case "$arg" in
    --from-source) FROM_SOURCE=true ;;
    --version=*) CRABOT_VERSION="${arg#*=}" ;;
    --install-dir=*) INSTALL_DIR="${arg#*=}" ;;
  esac
done

# --- 颜色 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${GREEN}[crabot]${NC} $1"; }
warn()    { echo -e "${YELLOW}[crabot]${NC} $1"; }
error()   { echo -e "${RED}[crabot]${NC} $1"; }
section() { echo -e "\n${BOLD}${CYAN}── $1 ──${NC}\n"; }

# --- OS 检测 ---
detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) error "Unsupported OS: $(uname -s)"; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
  echo "${os}-${arch}"
}

# --- Node.js 检查/安装（统一走 nvm，避免与系统包冲突）---
NVM_INSTALLER_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh"

load_nvm() {
  # nvm 是 shell function，必须 source 才能调用
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    \. "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
  fi
}

ensure_node() {
  load_nvm

  if command -v node &>/dev/null; then
    local current
    current=$(node -v | tr -d 'v')
    if version_ge "$current" "$REQUIRED_NODE_VERSION"; then
      info "Node.js $current found (>= $REQUIRED_NODE_VERSION)"
      return
    fi
    warn "Node.js $current found, but >= $REQUIRED_NODE_VERSION required; switching via nvm"
  fi

  section "Installing Node.js (via nvm)"

  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    info "Installing nvm..."
    curl -fsSL "$NVM_INSTALLER_URL" | bash
    load_nvm
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      error "nvm installation failed (NVM_DIR=$NVM_DIR)"
      exit 1
    fi
  fi

  nvm install 22
  nvm use 22
  nvm alias default 22

  info "Node.js $(node -v) installed via nvm"
}

# --- uv 检查/安装 ---
ensure_uv() {
  if command -v uv &>/dev/null; then
    info "uv $(uv --version) found"
    return
  fi
  section "Installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  info "uv $(uv --version) installed"
}

# --- pnpm（仅源码安装路径需要，release 包内含 dist/） ---
ensure_pnpm() {
  if ! command -v corepack &>/dev/null; then
    error "corepack not found (Node 16.13+ required). Reinstall Node.js."
    exit 1
  fi
  section "Activating pnpm via corepack"
  corepack enable
  # 读取根 package.json 的 packageManager 字段并激活
  corepack prepare --activate
  info "pnpm $(corepack pnpm --version) ready"
}

# --- 版本比较 ---
version_ge() {
  local IFS=.
  local i ver1=($1) ver2=($2)
  for ((i=0; i<${#ver2[@]}; i++)); do
    if ((10#${ver1[i]:-0} > 10#${ver2[i]:-0})); then return 0; fi
    if ((10#${ver1[i]:-0} < 10#${ver2[i]:-0})); then return 1; fi
  done
  return 0
}

# --- 主流程 ---
main() {
  section "Crabot Installer"
  local platform
  platform=$(detect_platform)
  info "Platform: $platform"

  ensure_node
  ensure_uv

  if [ "$FROM_SOURCE" = true ]; then
    ensure_pnpm
    section "Source Install"
    info "Installing pnpm dependencies (root)..."
    corepack pnpm install
    info "Building all modules..."
    # shared 必须先编译（其他模块依赖它）
    (cd crabot-shared && corepack pnpm install && corepack pnpm run build)
    for dir in crabot-core crabot-admin crabot-agent crabot-channel-host crabot-channel-wechat crabot-channel-telegram crabot-channel-feishu crabot-mcp-tools; do
      if [ -d "$dir" ]; then
        (cd "$dir" && corepack pnpm install && corepack pnpm run build)
      fi
    done
    # 前端依赖与构建（之前漏装）
    if [ -d "crabot-admin/web" ]; then
      (cd crabot-admin/web && corepack pnpm install && corepack pnpm run build)
    fi
    corepack pnpm run build:cli
    info "Setting up Python environment..."
    (cd crabot-memory && uv sync)
    info "Source install complete."
  else
    section "Release Install"
    # 获取版本
    local version="$CRABOT_VERSION"
    if [ "$version" = "latest" ]; then
      # 用 /releases/latest 的重定向拿真实 tag
      # （atom feed 的 <title> 是 release 标题，可能含 commit message + 中文，不能当 tag 用）
      local latest_url
      latest_url=$(curl -sLI -o /dev/null -w '%{url_effective}' \
        "https://github.com/smilefufu/crabot/releases/latest")
      version="${latest_url##*/tag/}"
      if [ -z "$version" ] || [ "$version" = "$latest_url" ]; then
        error "Failed to fetch latest version from GitHub. Set CRABOT_VERSION manually."
        exit 1
      fi
      info "Latest version: $version"
    fi

    # 下载
    local filename="crabot-${version}-${platform}.tar.gz"
    local url="https://github.com/smilefufu/crabot/releases/download/${version}/${filename}"
    info "Downloading $filename..."
    mkdir -p "$INSTALL_DIR"
    curl -fsSL "$url" -o "/tmp/$filename"

    # Checksum 校验
    local checksum_url="${url}.sha256"
    if curl -fsSL "$checksum_url" -o "/tmp/${filename}.sha256" 2>/dev/null; then
      info "Verifying checksum..."
      (cd /tmp && sha256sum -c "${filename}.sha256") || {
        error "Checksum verification failed!"
        exit 1
      }
    fi

    # 解压
    info "Extracting to $INSTALL_DIR..."
    tar -xzf "/tmp/$filename" -C "$INSTALL_DIR" --strip-components=1
    # 写 VERSION 文件供 crabot upgrade 检测当前版本
    echo "$version" > "$INSTALL_DIR/VERSION"
    rm -f "/tmp/$filename" "/tmp/${filename}.sha256"

    # Python 依赖
    info "Setting up Python environment..."
    (cd "$INSTALL_DIR/crabot-memory" && uv sync)
  fi

  # PATH 设置
  section "Setting up PATH"
  local bin_dir="$HOME/.local/bin"
  mkdir -p "$bin_dir"

  local crabot_path
  if [ "$FROM_SOURCE" = true ]; then
    crabot_path="$(pwd)/cli.mjs"
  else
    crabot_path="$INSTALL_DIR/cli.mjs"
  fi
  ln -sf "$crabot_path" "$bin_dir/crabot"
  chmod +x "$crabot_path"

  # 持久化 PATH 到 shell profile
  # 注意：不能用 `echo "$PATH" | grep` 判断，因为 ensure_uv 可能已经把 $bin_dir
  # 临时 export 到本进程 PATH 里，导致误判"已在 PATH"而不写 rc。
  # 必须直接检查 shell profile 文件内容。
  local shell_rc
  case "$SHELL" in
    */zsh)  shell_rc="$HOME/.zshrc" ;;
    */bash) shell_rc="$HOME/.bashrc" ;;
    *)      shell_rc="$HOME/.profile" ;;
  esac
  if [ -f "$shell_rc" ] && grep -q "$bin_dir" "$shell_rc"; then
    info "PATH already configured in $shell_rc"
  else
    echo "export PATH=\"$bin_dir:\$PATH\"" >> "$shell_rc"
    warn "Added $bin_dir to PATH in $shell_rc. Restart your shell or run:"
    echo "  export PATH=\"$bin_dir:\$PATH\""
  fi

  section "Done!"
  info "Run 'crabot start' to start Crabot (will prompt for admin password on first run)."
  info "Run 'crabot --help' for all commands."
}

# 仅在被直接执行时跑 main；被 source 时（例如测试）只暴露函数。
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  main "$@"
fi
