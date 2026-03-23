#!/bin/bash

# Crabot Start - 生产模式启动
# 由 crabot 主入口调用，不直接运行

set -e

# 不设置 CRABOT_DEV（与 dev.sh 的关键区别）

load_env
mkdir -p "$DATA_DIR/admin" "$DATA_DIR/agent" "$DATA_DIR/litellm" "$DATA_DIR/memory"

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
log_info "Module Manager 启动中（port 19000）..."
log_info "Admin Web 界面: http://localhost:3000"
cd "$CRABOT_HOME/crabot-core"
exec node dist/main.js
