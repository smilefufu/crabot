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
# 标记 ensure_node 是否通过 nvm 切换了 node；末尾给用户提示当前 shell 仍是旧 node
NODE_SWITCHED_BY_NVM=false
NODE_PREV_VERSION=""

# 解析参数
SYSTEM_MODE=false
for arg in "$@"; do
  case "$arg" in
    --from-source) FROM_SOURCE=true ;;
    --system) SYSTEM_MODE=true ;;
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

# --system 模式：需要 root；覆盖默认安装目录
if [ "$SYSTEM_MODE" = "true" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    error "--system requires root; rerun with sudo"
    exit 1
  fi
  INSTALL_DIR="${INSTALL_DIR:-/opt/crabot}"
fi

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
    NODE_PREV_VERSION="$current"
    warn "Node.js $current found, but >= $REQUIRED_NODE_VERSION required; switching via nvm"
    warn "注意：nvm 切换只在本脚本进程内生效，您当前 shell 的 node 仍是 $current"
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

  NODE_SWITCHED_BY_NVM=true
  info "Node.js $(node -v) installed via nvm (本进程内)"
}

# --- system-level Node 探测（--system 模式，要求 nobody 可达）---
ensure_system_node() {
  if ! sudo -u nobody bash -c 'command -v node && node --version' &>/dev/null; then
    error "system-level Node not found (probe user 'nobody' cannot run \`node --version\`)."
    error "install Node 22+ system-wide first, e.g. on Ubuntu/Debian:"
    error "  # 1) 先卸掉发行版自带的 node 12（否则 nodesource 22 会因 /usr/include/node/common.gypi 冲突装不上）"
    error "  sudo apt-get purge -y nodejs libnode-dev libnode72"
    error "  sudo apt-get autoremove -y"
    error "  # 2) 加 nodesource 22 源并安装"
    error "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -"
    error "  sudo apt-get install -y nodejs"
    exit 1
  fi
  local v
  v=$(sudo -u nobody node --version | tr -d 'v')
  if ! version_ge "$v" "$REQUIRED_NODE_VERSION"; then
    error "system Node $v < required $REQUIRED_NODE_VERSION"
    error "如果是 Ubuntu/Debian 自带的旧 node，先 purge 再装 nodesource 22："
    error "  sudo apt-get purge -y nodejs libnode-dev libnode72 && sudo apt-get autoremove -y"
    error "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -"
    error "  sudo apt-get install -y nodejs"
    exit 1
  fi
  info "system Node $v found"
}

# --- system-level uv 探测（--system 模式，要求 nobody 可达）---
ensure_system_uv() {
  if ! sudo -u nobody bash -c 'command -v uv && uv --version' &>/dev/null; then
    error "system-level uv not found (probe user 'nobody' cannot run \`uv --version\`)."
    error "install uv system-wide first, e.g.:"
    error "  curl -LsSf https://astral.sh/uv/install.sh | sudo env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh"
    exit 1
  fi
  info "system uv found"
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
  # 不调 `corepack enable` —— 它会往 Node 安装目录写 pnpm/yarn 系统 shim，
  # 在 Linux 系统 Node 安装下需 sudo；Windows 上更直接 EPERM。后续所有
  # `corepack pnpm ...` 会按 packageManager 字段按需下载到用户 cache 执行，
  # 不需要 enable。
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

  if [ "$SYSTEM_MODE" = "true" ]; then
    ensure_system_node
    ensure_system_uv
  else
    ensure_node
    ensure_uv
  fi

  if [ "$FROM_SOURCE" = true ]; then
    ensure_pnpm
    section "Source Install"
    info "Installing pnpm dependencies (root)..."
    corepack pnpm install
    info "Building all modules..."
    # shared 必须先编译（其他模块依赖它）
    (cd crabot-shared && corepack pnpm install && corepack pnpm run build)
    for dir in crabot-core crabot-admin crabot-agent crabot-channel-wechat crabot-channel-telegram crabot-channel-feishu crabot-channel-dingtalk crabot-mcp-tools; do
      if [ -d "$dir" ]; then
        (cd "$dir" && corepack pnpm install && corepack pnpm run build)
      fi
    done
    # 前端依赖与构建（之前漏装）
    if [ -d "crabot-admin/web" ]; then
      (cd crabot-admin/web && corepack pnpm install && corepack pnpm run build)
    fi
    # scripts/lib 是独立 package（依赖 proper-lockfile 等），不属于 root workspace，需单独装
    if [ -d "scripts/lib" ]; then
      (cd scripts/lib && corepack pnpm install --prod)
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

  if [ "$SYSTEM_MODE" = "true" ]; then
    section "Creating /etc/crabot/ skeleton"

    # 创建 crabot group（如不存在）
    if ! getent group crabot &>/dev/null; then
      groupadd -r crabot
      info "created group 'crabot'"
    fi

    mkdir -p /etc/crabot/defaults /etc/crabot/registry
    chown root:root /etc/crabot
    chown root:root /etc/crabot/defaults
    chown root:crabot /etc/crabot/registry
    chmod 0755 /etc/crabot /etc/crabot/defaults
    chmod 0775 /etc/crabot/registry

    if [ ! -f /etc/crabot/registry/ports.json ]; then
      echo '[]' > /etc/crabot/registry/ports.json
      chown root:crabot /etc/crabot/registry/ports.json
      chmod 0664 /etc/crabot/registry/ports.json
    fi

    if [ ! -f /etc/crabot/cluster.version ]; then
      echo 0 > /etc/crabot/cluster.version
      chmod 0644 /etc/crabot/cluster.version
    fi

    # 铺一份供应商目录注释样例（.example 不激活；激活需改名为 vendor.yaml）
    if [ -f "$INSTALL_DIR/scripts/templates/vendor.yaml.example" ]; then
      cp "$INSTALL_DIR/scripts/templates/vendor.yaml.example" /etc/crabot/defaults/vendor.yaml.example
      chmod 0644 /etc/crabot/defaults/vendor.yaml.example
    fi

    # logrotate
    cat > /etc/logrotate.d/crabot <<'LR'
/home/*/.crabot/data*/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su root root
}
LR
    info "created /etc/logrotate.d/crabot"
  fi

  # PATH 设置
  section "Setting up PATH"

  if [ "$SYSTEM_MODE" = "true" ]; then
    local crabot_path
    if [ "$FROM_SOURCE" = true ]; then
      crabot_path="$(pwd)/cli.mjs"
    else
      crabot_path="$INSTALL_DIR/cli.mjs"
    fi
    ln -sf "$crabot_path" /usr/local/bin/crabot
    chmod +x "$crabot_path"
    info "linked /usr/local/bin/crabot → $crabot_path"
    # 跳过写 ~/.shellrc——root 跑了不该污染 root 的 rc
  else
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
  fi

  if [ "$SYSTEM_MODE" = "true" ]; then
    section "Done! (system mode)"
    info "下一步："
    info "  1. 把员工加入 crabot group:"
    info "     sudo usermod -a -G crabot alice"
    info "     sudo usermod -a -G crabot bob"
    info "  2. (可选) 自定义员工可选供应商目录：sudo crabot vendor add，或编辑 /etc/crabot/defaults/vendor.yaml（参考同目录 .example）"
    info "  3. 通知员工：crabot start 即可（vendor 改动各员工重启 crabot 后自动生效，无需 sync）"
  else
    section "Done!"
    if [ "$NODE_SWITCHED_BY_NVM" = "true" ]; then
      echo
      warn "==========================================================="
      warn " 重要：您当前 shell 的 Node 仍是 v${NODE_PREV_VERSION}（脚本只在自己进程切到 v22）"
      warn " 直接运行 'crabot start' 会触发 ERR_REQUIRE_ESM 报错"
      warn ""
      warn " 请任选其一后再运行 crabot start："
      warn "   1) nvm use default              # 当前 shell 切到 nvm 默认（已设为 22）"
      warn "   2) 新开一个 terminal             # 让 shell rc 重新加载 nvm 默认"
      warn "==========================================================="
      echo
    else
      info "Run 'crabot start' to start Crabot (will prompt for admin password on first run)."
      info "Run 'crabot --help' for all commands."
    fi
  fi
}

# 仅在被直接执行时跑 main；被 source 时（例如测试）只暴露函数。
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  main "$@"
fi
