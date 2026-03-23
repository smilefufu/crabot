#!/bin/bash
# Memory 模块启动脚本

set -e

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Crabot Memory Module Startup ===${NC}\n"

# 检查环境变量
if [ -z "$CRABOT_LLM_API_KEY" ]; then
    echo -e "${YELLOW}Warning: CRABOT_LLM_API_KEY not set${NC}"
    echo "Using default test key (API calls will fail)"
    export CRABOT_LLM_API_KEY="test-key"
fi

if [ -z "$CRABOT_EMBEDDING_API_KEY" ]; then
    echo -e "${YELLOW}Warning: CRABOT_EMBEDDING_API_KEY not set${NC}"
    echo "Using default test key (API calls will fail)"
    export CRABOT_EMBEDDING_API_KEY="test-key"
fi

# 设置默认配置
export CRABOT_MEMORY_PORT="${CRABOT_MEMORY_PORT:-19002}"
export CRABOT_MEMORY_DATA_DIR="${CRABOT_MEMORY_DATA_DIR:-./data/memory}"
export CRABOT_MODULE_MANAGER_URL="${CRABOT_MODULE_MANAGER_URL:-http://localhost:19000}"

echo "Configuration:"
echo "  - Port: $CRABOT_MEMORY_PORT"
echo "  - Data dir: $CRABOT_MEMORY_DATA_DIR"
echo "  - Module Manager: $CRABOT_MODULE_MANAGER_URL"
echo ""

# 创建数据目录
mkdir -p "$CRABOT_MEMORY_DATA_DIR"

# 启动模块
echo -e "${GREEN}Starting Memory module...${NC}"
cd "$(dirname "$0")"

# 检查 uv 是否安装
if ! command -v uv &> /dev/null; then
    echo -e "${RED}Error: uv is not installed${NC}"
    echo "Please install uv: curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
fi

# 使用 uv 运行
uv run python src/main.py

# 捕获退出信号
trap 'echo -e "\n${YELLOW}Shutting down...${NC}"; exit 0' INT TERM
