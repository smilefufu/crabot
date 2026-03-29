#!/bin/bash
# 已迁移到 Node.js，此脚本仅做转发以保持向后兼容
exec node "$(dirname "$0")/debug-agent.mjs" "$@"
