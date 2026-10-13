#!/bin/bash
set -e

# Crabot 安装脚本
# 用法:
#   远程安装: curl -fsSL <url>/install.sh | bash
#   源码安装: ./install.sh --from-source

CRABOT_VERSION="${CRABOT_VERSION:-latest}"
INSTALL_DIR="${CRABOT_INSTALL_DIR:-}"
REQUIRED_NODE_VERSION="22.14.0"
FROM_SOURCE=false
# 标记 ensure_node 是否通过 nvm 切换了 node；末尾给用户提示当前 shell 仍是旧 node
NODE_SWITCHED_BY_NVM=false
NODE_PREV_VERSION=""
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

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
error()   { echo -e "${RED}[crabot]${NC} $1" >&2; }
section() { echo -e "\n${BOLD}${CYAN}── $1 ──${NC}\n"; }

# --system 模式：需要 root；覆盖默认安装目录
if [ "$SYSTEM_MODE" = "true" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    error "--system requires root; rerun with sudo"
    exit 1
  fi
  INSTALL_DIR="${INSTALL_DIR:-/opt/crabot}"
fi
INSTALL_DIR="${INSTALL_DIR:-$HOME/.crabot}"

# --- OS 检测 ---
detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) error "Windows: use install.ps1 from PowerShell (not install.sh in Git Bash)."; return 1 ;;
    *) error "Unsupported OS: $(uname -s)"; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
  case "${os}-${arch}" in
    darwin-x64|darwin-arm64|linux-x64) echo "${os}-${arch}" ;;
    *) error "Unsupported release platform: ${os}-${arch}; no native package is published."; return 1 ;;
  esac
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
    local uv_version
    uv_version=$(uv --version) || { error "uv version probe failed"; return 1; }
    info "$uv_version found"
    return
  fi
  section "Installing uv"
  if ! (set -o pipefail; curl -LsSf https://astral.sh/uv/install.sh | sh); then
    error "uv installation failed during download or installer execution"; return 1
  fi
  export PATH="$HOME/.local/bin:$PATH"
  local uv_version
  uv_version=$(uv --version) || { error "uv was not installed at a usable PATH"; return 1; }
  info "$uv_version installed"
}

# --- pnpm（仅源码安装路径需要，release 包内含 dist/） ---
ensure_pnpm() {
  local pnpm_version
  if command -v corepack >/dev/null 2>&1 && pnpm_version=$(corepack pnpm@9.15.9 --version); then
    info "pnpm $pnpm_version ready"; return
  fi
  local tools="$HOME/.local/share/crabot/corepack"
  mkdir -p "$tools"
  npm install --prefix "$tools" --no-audit --no-fund --ignore-scripts --registry=https://registry.npmjs.org corepack@0.31.0 || { error "Corepack preparation failed"; return 1; }
  CRABOT_COREPACK_JS="$tools/node_modules/corepack/dist/corepack.js"
  mkdir -p "$HOME/.local/bin"
  if [ ! -e "$HOME/.local/bin/corepack" ] && [ ! -L "$HOME/.local/bin/corepack" ]; then ln -s "$CRABOT_COREPACK_JS" "$HOME/.local/bin/corepack"; fi
  corepack() { node "$CRABOT_COREPACK_JS" "$@"; }
  export CRABOT_COREPACK_JS
  export -f corepack
  pnpm_version=$(corepack pnpm@9.15.9 --version) || { error "Corepack could not run pnpm after preparation"; return 1; }
  info "pnpm $pnpm_version ready"
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

# --- PATH（兼容登录 shell、ZDOTDIR 和字面路径）---
append_path() {
  local file="$1" line='export PATH="$HOME/.local/bin:$PATH"'
  if [ ! -f "$file" ] || ! grep -Fqx "$line" "$file"; then
    printf '\n%s\n' "$line" >> "$file"
  fi
}
configure_path() {
  local crabot_path="$INSTALL_DIR/cli.mjs"
  if [ "$FROM_SOURCE" = true ]; then crabot_path="$SOURCE_DIR/cli.mjs"; fi
  if [ "$SYSTEM_MODE" = true ]; then
    ln -sf "$crabot_path" /usr/local/bin/crabot
    chmod +x "$crabot_path"
    return
  fi
  local bin_dir="$HOME/.local/bin" shell_rc
  mkdir -p "$bin_dir"
  if [ -e "$bin_dir/crabot" ] && { [ ! -L "$bin_dir/crabot" ] || [ "$(readlink "$bin_dir/crabot")" != "$crabot_path" ]; }; then
    warn "Preserving existing launcher: $bin_dir/crabot; new CLI: $crabot_path"
  else
    ln -sf "$crabot_path" "$bin_dir/crabot"
  fi
  chmod +x "$crabot_path"
  case "$SHELL" in
    */zsh)
      mkdir -p "${ZDOTDIR:-$HOME}"
      shell_rc="${ZDOTDIR:-$HOME}/.zshrc"
      append_path "$shell_rc" ;;
    */bash)
      append_path "$HOME/.bashrc"
      shell_rc="$HOME/.bash_profile"
      for file in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
        if [ -f "$file" ]; then shell_rc="$file"; break; fi
      done
      append_path "$shell_rc" ;;
    *) shell_rc="$HOME/.profile"; append_path "$shell_rc" ;;
  esac
  export PATH="$bin_dir:$PATH"
  info "PATH configured in $shell_rc; open a new terminal or run: export PATH=\"\$HOME/.local/bin:\$PATH\""
}

assert_stopped() {
  node --input-type=module - "$INSTALL_DIR" <<'JS'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
const root = process.argv[2]
for (const home of new Set([root, path.join(os.homedir(), '.crabot')])) {
  let instance = {}
  const config = path.join(home, 'instance.json')
  if (fs.existsSync(config)) instance = JSON.parse(fs.readFileSync(config, 'utf8'))
  const data = process.env.DATA_DIR || instance.data_dir || path.join(home, 'data')
  const pidFile = path.join(data, 'mm.pid')
  if (!fs.existsSync(pidFile)) continue
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) continue
  try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') continue; throw error }
  throw new Error(`Crabot is running (PID ${pid}); run crabot stop before installing`)
}
JS
}

# 已知旧包没有新 verifier；严格限制代际并检查该代应有的入口。
verify_release() {
  local root="$1" version="$2" file
  for file in cli.mjs package.json dist/cli/main.js scripts/start.mjs crabot-memory/pyproject.toml crabot-memory/uv.lock; do
    [ -f "$root/$file" ] || { error "Release package missing $file"; return 1; }
  done
  if [ -f "$root/scripts/check-release.mjs" ]; then
    node "$root/scripts/check-release.mjs" "$version"
  else
    case "$version" in
      v2026.9.23|v2026.10.12.4)
        for file in scripts/prepare-computer-use.mjs scripts/computer-use/runtime.json crabot-mcp-tools/dist/computer-use/service.js; do
          [ ! -e "$root/$file" ] || { error "Mixed release generation: $file"; return 1; }
        done
        if [ "$version" = v2026.10.12.4 ]; then
          node "$root/scripts/prepare-scrapling.mjs" --check
        elif [ -e "$root/scripts/prepare-scrapling.mjs" ]; then
          error "Mixed release generation: Scrapling"; return 1
        fi ;;
      *) error "Release package missing scripts/check-release.mjs"; return 1 ;;
    esac
  fi
}

# --- 主流程 ---
main() {
  section "Crabot Installer"
  local platform
  platform=$(detect_platform)
  info "Platform: $platform"
  if [ "$SYSTEM_MODE" = true ] && [ "${platform%%-*}" != linux ]; then
    error "--system is supported only on Linux"; return 1
  fi
  if [ "${platform%%-*}" = linux ]; then
    local libc
    libc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || { error "Linux release requires glibc >= 2.35; musl/Alpine is not supported"; return 1; }
    version_ge "${libc#glibc }" 2.35 || { error "Linux release requires glibc >= 2.35, found $libc"; return 1; }
  fi

  if [ "$SYSTEM_MODE" = "true" ]; then
    ensure_system_node
    ensure_system_uv
  else
    ensure_node
    ensure_uv
  fi

  local node_os node_arch
  node_os=$(node -p 'process.platform')
  node_arch=$(node -p 'process.arch')
  if [ "$node_os" != "${platform%%-*}" ]; then error "Node platform $node_os does not match $platform"; return 1; fi
  platform="${node_os}-${node_arch}"
  case "$platform" in darwin-x64|darwin-arm64|linux-x64) :;; *) error "Unsupported Node platform: $platform"; return 1;; esac

  if [ "$FROM_SOURCE" = true ]; then
    ensure_pnpm
    section "Source Install"
    (cd "$SOURCE_DIR" && node --input-type=module <<'JS'
import { runSourceUpgrade } from './scripts/upgrade-lib/source.mjs'
await runSourceUpgrade(process.cwd(), console)
JS
    )
    info "Source install complete."
  else
    section "Release Install"
    # 获取版本
    local version="$CRABOT_VERSION"
    if [ "$version" = "latest" ]; then
      # 用 /releases/latest 的重定向拿真实 tag
      # （atom feed 的 <title> 是 release 标题，可能含 commit message + 中文，不能当 tag 用）
      local latest_url
      latest_url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
        "https://github.com/smilefufu/crabot/releases/latest")
      version="${latest_url##*/tag/}"
      if [ -z "$version" ] || [ "$version" = "$latest_url" ]; then
        error "Failed to fetch latest version from GitHub. Set CRABOT_VERSION manually."
        exit 1
      fi
      info "Latest version: $version"
    fi

    case "$version" in ''|*[!a-zA-Z0-9._-]*) error "Invalid release version: $version"; return 1;; esac
    assert_stopped
    CRABOT_DOWNLOAD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/crabot-install.XXXXXX")
    trap 'rm -rf "$CRABOT_DOWNLOAD_DIR"' EXIT
    local filename="crabot-${version}-${platform}.tar.gz"
    local url="https://github.com/smilefufu/crabot/releases/download/${version}/${filename}"
    info "Downloading $filename..."
    curl -fsSL "$url" -o "$CRABOT_DOWNLOAD_DIR/$filename" --connect-timeout 30 --max-time 900
    curl -fsSL "${url}.sha256" -o "$CRABOT_DOWNLOAD_DIR/${filename}.sha256" --connect-timeout 30 --max-time 60
    info "Verifying checksum..."
    (cd "$CRABOT_DOWNLOAD_DIR" && {
      if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "${filename}.sha256"
      else shasum -a 256 -c "${filename}.sha256"; fi
    }) || { error "Checksum verification failed!"; return 1; }
    local stage="$CRABOT_DOWNLOAD_DIR/package" entry
    mkdir -p "$stage"
    tar -xzf "$CRABOT_DOWNLOAD_DIR/$filename" -C "$stage" --strip-components=1
    verify_release "$stage" "$version"
    mkdir -p "$INSTALL_DIR"
    if [ "$SYSTEM_MODE" = true ]; then chown root:root "$INSTALL_DIR"; chmod 0755 "$INSTALL_DIR"; fi
    info "Installing verified package to $INSTALL_DIR..."
    for entry in "$stage"/* "$stage"/.[!.]*; do
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      local name="${entry##*/}"
      case "$name" in data|instance.json|agent-venv|VERSION) continue;; esac
      if [ "$name" = crabot.cmd ] && [ -e "$INSTALL_DIR/$name" ]; then continue; fi
      if [ "$name" = .computer-use-runtime ] && [ -d "$INSTALL_DIR/$name" ]; then
        for file in "$entry"/*; do
          [ -e "$file" ] || continue
          rm -rf "$INSTALL_DIR/$name/${file##*/}"
          mv "$file" "$INSTALL_DIR/$name/"
        done
      else
        rm -rf "$INSTALL_DIR/$name"
        mv "$entry" "$INSTALL_DIR/$name"
      fi
    done
    info "Setting up Python environment..."
    (cd "$INSTALL_DIR/crabot-memory" && uv sync --frozen --no-dev)
    rm -rf "$CRABOT_DOWNLOAD_DIR"

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

  section "Setting up PATH"
  configure_path
  if [ "$FROM_SOURCE" != true ]; then printf '%s\n' "$version" > "$INSTALL_DIR/VERSION"; fi

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
