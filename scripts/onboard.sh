#!/bin/bash

# Crabot Onboard - 环境初始化
# 由 crabot 主入口调用，不直接运行

set -e

# ── 参数解析 ──────────────────────────────────────────────

SKIP_DEPS=false
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=true ;;
    --skip-deps)       SKIP_DEPS=true ;;
  esac
done
export NON_INTERACTIVE="${NON_INTERACTIVE:-false}"

ONBOARD_LOG="$DATA_DIR/onboard.log"
mkdir -p "$DATA_DIR"
: > "$ONBOARD_LOG"

log_to_file() {
  echo "[$(date '+%H:%M:%S')] $1" >> "$ONBOARD_LOG"
}

# ═══════════════════════════════════════════════════════════
# 阶段 1：环境检测
# ═══════════════════════════════════════════════════════════

run_phase1_detect() {
  log_section "阶段 1/5：环境检测"

  OS="$(detect_os)"
  if [ "$OS" = "unknown" ]; then
    log_error "不支持的操作系统: $(uname -s)"
    log_error "Crabot 仅支持 macOS 和 Linux。Windows 用户请使用 WSL2。"
    exit 1
  fi
  log_success "操作系统: $OS ($(uname -m))"

  # 检测 shell 和 profile 路径
  SHELL_NAME="$(basename "$SHELL" 2>/dev/null || echo bash)"
  case "$SHELL_NAME" in
    zsh)  SHELL_PROFILE="$HOME/.zshrc" ;;
    bash) SHELL_PROFILE="$HOME/.bashrc" ;;
    *)    SHELL_PROFILE="$HOME/.profile" ;;
  esac
  log_success "Shell: $SHELL_NAME (profile: $SHELL_PROFILE)"
}

# ═══════════════════════════════════════════════════════════
# 阶段 2：前置工具检查与安装
# ═══════════════════════════════════════════════════════════

check_tool_status() {
  # 返回值: 0=已安装且版本满足, 1=未安装, 2=版本不满足
  local tool="$1"
  case "$tool" in
    build-tools)
      if [ "$OS" = "macos" ]; then
        xcode-select -p &>/dev/null && return 0 || return 1
      else
        command -v gcc &>/dev/null && return 0 || return 1
      fi
      ;;
    nvm)
      [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] && return 0 || return 1
      ;;
    node)
      if ! command -v node &>/dev/null; then return 1; fi
      local ver
      ver="$(node -v 2>/dev/null | sed 's/^v//')"
      version_ge "$ver" "18.0.0" && return 0 || return 2
      ;;
    python)
      if ! command -v python3 &>/dev/null; then return 1; fi
      local ver
      ver="$(python3 -V 2>/dev/null | awk '{print $2}')"
      version_ge "$ver" "3.10.0" && return 0 || return 2
      ;;
    uv)
      command -v uv &>/dev/null && return 0 || return 1
      ;;
  esac
}

install_build_tools() {
  if [ "$OS" = "macos" ]; then
    log_info "安装 Xcode Command Line Tools..."
    xcode-select --install 2>/dev/null || true
    log_warn "请在弹出的窗口中完成安装，然后重新运行 ./crabot onboard"
    exit 0
  else
    if confirm "是否安装 build-essential？"; then
      sudo apt-get update -qq && sudo apt-get install -y build-essential >> "$ONBOARD_LOG" 2>&1
      log_success "build-essential 已安装"
    else
      log_error "请手动安装: sudo apt-get install build-essential"
      exit 1
    fi
  fi
}

install_nvm() {
  log_info "安装 nvm v0.40.1..."
  local install_script
  install_script="$(mktemp)"
  if ! curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh -o "$install_script" 2>>"$ONBOARD_LOG"; then
    rm -f "$install_script"
    log_error "下载 nvm 安装脚本失败（网络不通？）"
    log_error "  手动安装: https://github.com/nvm-sh/nvm#installing-and-updating"
    exit 1
  fi
  if ! bash "$install_script" >> "$ONBOARD_LOG" 2>&1; then
    rm -f "$install_script"
    log_error "nvm 安装脚本执行失败:"
    tail -5 "$ONBOARD_LOG" | sed 's/^/    /'
    log_error "  手动安装: https://github.com/nvm-sh/nvm#installing-and-updating"
    exit 1
  fi
  rm -f "$install_script"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck source=/dev/null
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    set +e; . "$NVM_DIR/nvm.sh"; set -e
    log_success "nvm 已安装"
  else
    log_error "nvm 安装后未找到 nvm.sh，请检查日志: $ONBOARD_LOG"
    exit 1
  fi
}

install_node() {
  # 确保 nvm 已加载
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck source=/dev/null
  set +e; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; set -e

  log_info "安装 Node.js (读取 .nvmrc) ..."
  local _saved_dir="$PWD"
  cd "$CRABOT_HOME"
  nvm install >> "$ONBOARD_LOG" 2>&1
  cd "$_saved_dir"
  log_success "Node.js $(node -v) 已安装"
}

install_uv() {
  log_info "安装 uv..."
  curl -LsSf https://astral.sh/uv/install.sh 2>>"$ONBOARD_LOG" | sh >> "$ONBOARD_LOG" 2>&1
  # 将 uv 加入当前 PATH（安装器默认放这两个位置）
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  if command -v uv &>/dev/null; then
    log_success "uv $(uv --version 2>/dev/null | awk '{print $2}') 已安装"
  else
    log_error "uv 安装失败，请手动安装: https://docs.astral.sh/uv/"
    exit 1
  fi
}

run_phase2_tools() {
  log_section "阶段 2/5：前置工具检查"

  local all_ok=true

  # 编译工具
  if check_tool_status build-tools; then
    log_success "编译工具已就绪"
  else
    all_ok=false
    if confirm "是否安装编译工具？"; then
      install_build_tools
    else
      log_error "编译工具是必须的。macOS: xcode-select --install; Linux: sudo apt install build-essential"
      exit 1
    fi
  fi

  # nvm
  if check_tool_status nvm; then
    log_success "nvm 已就绪"
  else
    all_ok=false
    if confirm "是否安装 nvm（Node 版本管理器）？"; then
      install_nvm
    else
      log_error "需要 nvm 来管理 Node.js 版本。安装: https://github.com/nvm-sh/nvm"
      exit 1
    fi
  fi

  # Node.js
  # 确保 nvm 已加载
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck source=/dev/null
  # nvm.sh 不兼容 set -e（已知问题 nvm#1985）
  set +e; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; set -e

  local node_status=0
  check_tool_status node || node_status=$?
  if [ "$node_status" -eq 0 ]; then
    log_success "Node.js $(node -v) 已就绪"
  else
    all_ok=false
    if [ "$node_status" -eq 2 ]; then
      log_warn "Node.js $(node -v) 版本过低（需要 >= 18）"
    fi
    if confirm "是否通过 nvm 安装 Node.js？"; then
      install_node
    else
      log_error "需要 Node.js >= 18。安装: nvm install 20"
      exit 1
    fi
  fi

  # Python
  local python_status=0
  check_tool_status python || python_status=$?
  if [ "$python_status" -eq 0 ]; then
    log_success "Python $(python3 -V 2>/dev/null | awk '{print $2}') 已就绪"
  else
    if [ "$python_status" -eq 2 ]; then
      log_error "Python $(python3 -V 2>/dev/null | awk '{print $2}') 版本过低（需要 >= 3.10）"
    else
      log_error "Python 3 未安装"
    fi
    log_error "请手动安装 Python >= 3.10："
    if [ "$OS" = "macos" ]; then
      log_error "  brew install python@3.12"
    else
      log_error "  sudo apt install python3 python3-pip python3-venv"
    fi
    exit 1
  fi

  # uv（安装器默认放 ~/.local/bin 或 ~/.cargo/bin，确保在 PATH 中）
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  if check_tool_status uv; then
    log_success "uv 已就绪"
  else
    all_ok=false
    if confirm "是否安装 uv（Python 包管理器）？"; then
      install_uv
    else
      log_error "需要 uv 来管理 Python 依赖。安装: https://docs.astral.sh/uv/"
      exit 1
    fi
  fi

  if [ "$all_ok" = true ]; then
    log_info "所有前置工具已就绪"
  fi
}

# ═══════════════════════════════════════════════════════════
# 阶段 3：.env 配置
# ═══════════════════════════════════════════════════════════

run_phase3_env() {
  log_section "阶段 3/5：环境配置"

  if [ -f "$CRABOT_HOME/.env" ]; then
    log_info ".env 已存在，跳过"
    return 0
  fi

  if [ ! -f "$CRABOT_HOME/.env.example" ]; then
    log_error ".env.example 不存在，无法生成 .env"
    exit 1
  fi

  log_info "生成 .env 配置文件..."

  # 复制模板
  cp "$CRABOT_HOME/.env.example" "$CRABOT_HOME/.env"

  # 自动生成密钥
  local jwt_secret
  jwt_secret="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p | tr -d '\n' | head -c 64)"
  local encryption_key
  encryption_key="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p | tr -d '\n' | head -c 64)"

  # 获取管理员密码
  local admin_password
  if [ "$NON_INTERACTIVE" = "true" ]; then
    admin_password="$(openssl rand -base64 16 2>/dev/null | tr -d '=/+' | head -c 16)"
    log_warn "已自动生成管理员密码（请查看 .env 文件获取）"
  else
    # 清空 stdin 残留输入，避免前面 confirm 的多余回车被吃掉
    read -r -t 0.1 -n 10000 _ 2>/dev/null || true
    printf "${YELLOW}[crabot]${NC} 请设置管理员密码（直接回车使用随机密码）: "
    read -r admin_password
    if [ -z "$admin_password" ]; then
      admin_password="$(openssl rand -base64 16 2>/dev/null | tr -d '=/+' | head -c 16)"
      log_warn "已自动生成管理员密码（请查看 .env 文件获取）"
    fi
  fi

  # 写入 .env（用 awk 逐行替换，不依赖 python3，避免 sed 特殊字符注入）
  local tmp_env
  tmp_env="$(mktemp)"
  awk -v "v1=$admin_password" \
      -v "v2=$jwt_secret" \
      -v "v3=$encryption_key" \
      'BEGIN{FS=OFS="="}
       /^CRABOT_ADMIN_PASSWORD=/{$2=v1}
       /^CRABOT_JWT_SECRET=/{$2=v2}
       /^ADMIN_ENCRYPTION_KEY=/{$2=v3}
       {print}' "$CRABOT_HOME/.env" > "$tmp_env"
  mv "$tmp_env" "$CRABOT_HOME/.env"

  chmod 600 "$CRABOT_HOME/.env"

  # 确保 data/admin 目录存在（模块配置需要）
  mkdir -p "$DATA_DIR/admin"

  log_success ".env 配置完成"
}

# ═══════════════════════════════════════════════════════════
# 阶段 4：依赖安装
# ═══════════════════════════════════════════════════════════

run_phase4_deps() {
  log_section "阶段 4/5：依赖安装"

  if [ "$SKIP_DEPS" = true ]; then
    log_info "跳过依赖安装（--skip-deps）"
    return 0
  fi

  # 确保 nvm 已加载，并切换到 .nvmrc 指定的 Node 版本
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck source=/dev/null
  set +e; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; set -e
  # nvm install 会读 .nvmrc，版本已装则直接切换，未装则先安装
  # 注意：不能用子 shell (cd ... && nvm use)，否则版本切换不传回父进程
  local _saved_dir="$PWD"
  cd "$CRABOT_HOME"
  nvm install || {
    log_error "无法切换到 .nvmrc 指定的 Node 版本"
    exit 1
  }
  cd "$_saved_dir"
  log_success "Node $(node -v) 已激活"

  log_info "并行安装 npm 依赖 (详细日志: $ONBOARD_LOG) ..."

  local pids=()
  local names=()

  # 并行安装：crabot-core, crabot-agent, crabot-channel-host, crabot-memory
  for mod in crabot-core crabot-agent crabot-channel-host; do
    if [ -d "$CRABOT_HOME/$mod" ]; then
      (cd "$CRABOT_HOME/$mod" && npm install >> "$ONBOARD_LOG.$mod" 2>&1) &
      pids+=($!)
      names+=("$mod")
    fi
  done

  # crabot-memory: uv sync
  if [ -d "$CRABOT_HOME/crabot-memory" ]; then
    (cd "$CRABOT_HOME/crabot-memory" && uv sync >> "$ONBOARD_LOG.crabot-memory" 2>&1) &
    pids+=($!)
    names+=("crabot-memory")
  fi

  # 等待并行任务完成
  local fail=0
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then
      log_success "${names[$i]}"
    else
      log_error "${names[$i]} 安装失败:"
      # 显示该模块日志最后 10 行，帮助用户快速定位
      if [ -f "$ONBOARD_LOG.${names[$i]}" ]; then
        tail -10 "$ONBOARD_LOG.${names[$i]}" | sed 's/^/    /'
      fi
      fail=1
    fi
  done

  # 合并各模块日志
  for mod_name in "${names[@]}"; do
    if [ -f "$ONBOARD_LOG.$mod_name" ]; then
      echo "=== $mod_name ===" >> "$ONBOARD_LOG"
      cat "$ONBOARD_LOG.$mod_name" >> "$ONBOARD_LOG"
      rm -f "$ONBOARD_LOG.$mod_name"
    fi
  done

  if [ "$fail" -eq 1 ]; then
    log_error "部分依赖安装失败 (完整日志: $ONBOARD_LOG)"
    exit 1
  fi

  # 串行安装：crabot-admin（原生模块编译，并行可能导致资源竞争）
  if [ -d "$CRABOT_HOME/crabot-admin" ]; then
    log_info "安装 crabot-admin 依赖 (含原生模块编译) ..."
    (cd "$CRABOT_HOME/crabot-admin" && npm install >> "$ONBOARD_LOG" 2>&1) || {
      log_error "crabot-admin 安装失败:"
      tail -10 "$ONBOARD_LOG" | sed 's/^/    /'
      exit 1
    }
    log_success "crabot-admin"
  fi

  # 串行：crabot-admin/web
  if [ -d "$CRABOT_HOME/crabot-admin/web" ]; then
    log_info "安装前端依赖..."
    (cd "$CRABOT_HOME/crabot-admin/web" && npm install >> "$ONBOARD_LOG" 2>&1) || {
      log_error "crabot-admin/web 安装失败:"
      tail -10 "$ONBOARD_LOG" | sed 's/^/    /'
      exit 1
    }
    log_success "crabot-admin/web"
  fi

  log_info "所有依赖安装完成"
}

# ═══════════════════════════════════════════════════════════
# 阶段 5：验证 + 输出
# ═══════════════════════════════════════════════════════════

run_phase5_verify() {
  log_section "阶段 5/5：验证"

  local all_ok=true

  # 检查 node_modules
  for mod in crabot-core crabot-admin crabot-agent crabot-channel-host; do
    if [ -d "$CRABOT_HOME/$mod" ]; then
      if [ -d "$CRABOT_HOME/$mod/node_modules" ]; then
        log_success "$mod/node_modules"
      else
        log_warn "$mod/node_modules 不存在"
        all_ok=false
      fi
    fi
  done

  # 检查前端依赖
  if [ -d "$CRABOT_HOME/crabot-admin/web/node_modules" ]; then
    log_success "crabot-admin/web/node_modules"
  else
    log_warn "crabot-admin/web/node_modules 不存在"
    all_ok=false
  fi

  # 检查 Python 虚拟环境
  if [ -d "$CRABOT_HOME/crabot-memory/.venv" ]; then
    log_success "crabot-memory/.venv"
  else
    log_warn "crabot-memory/.venv 不存在"
    all_ok=false
  fi

  # 检查 .env
  if [ -f "$CRABOT_HOME/.env" ]; then
    log_success ".env"
  else
    log_warn ".env 不存在"
    all_ok=false
  fi


  echo ""
  if [ "$all_ok" = true ]; then
    log_success "Onboard 完成！"
  else
    log_warn "Onboard 完成，但有部分检查未通过（见上方警告）"
  fi

  echo ""
  echo -e "${BOLD}下一步：${NC}"
  echo -e "  ${CYAN}./crabot start${NC}    启动 Crabot（生产模式）"
  echo -e "  ${CYAN}./dev.sh${NC}          启动开发环境（含 HMR）"
  echo ""
}

# ═══════════════════════════════════════════════════════════
# 主流程
# ═══════════════════════════════════════════════════════════

run_phase1_detect
run_phase2_tools
run_phase3_env
run_phase4_deps
run_phase5_verify
