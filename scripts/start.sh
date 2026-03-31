#!/bin/bash

# Crabot Start - 生产模式启动
# 由 crabot 主入口调用，不直接运行

set -e

# 不设置 CRABOT_DEV（与 dev.sh 的关键区别）

load_env
mkdir -p "$DATA_DIR/admin" "$DATA_DIR/agent" "$DATA_DIR/litellm" "$DATA_DIR/memory"

# 0. 确保 nvm 已加载，切换到 .nvmrc 指定的 Node 版本
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
# nvm.sh 不兼容 set -e（已知问题 nvm#1985）
set +e; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; set -e
local_saved_dir="$PWD"
cd "$CRABOT_HOME"
nvm use || {
  log_error "无法切换到 .nvmrc 指定的 Node 版本，请先运行 ./crabot onboard"
  exit 1
}
cd "$local_saved_dir"

# 1. LiteLLM
log_section "启动 LiteLLM"
start_litellm

# 2. Memory 依赖
log_section "同步依赖"
sync_memory_deps

# 3. 构建所有模块
log_section "构建"
build_all_modules || exit 1
build_frontend || exit 1

# 4. Module Manager（前台 exec）
log_section "启动 Crabot"
local _offset="${CRABOT_PORT_OFFSET:-0}"
local _mm_port=$((19000 + _offset))
local _web_port=$((3000 + _offset))
log_info "Module Manager 启动中 (port $_mm_port) ..."
log_info "Admin Web: http://localhost:$_web_port"
cd "$CRABOT_HOME/crabot-core"
exec node dist/main.js
