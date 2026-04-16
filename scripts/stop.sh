#!/bin/bash

# Crabot Stop - 优雅关闭
# 由 crabot 主入口调用，不直接运行

load_env 2>/dev/null || true
stop_all_services
