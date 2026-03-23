"""
Memory 模块入口
"""
import asyncio
import signal
import sys
import os
from pathlib import Path

# 添加父目录到 Python 路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.config import load_config
from src.module import MemoryModule


async def main():
    """主函数"""
    # 加载配置
    config_path = os.environ.get("CRABOT_MEMORY_CONFIG")
    config = load_config(config_path)

    # 创建模块
    module = MemoryModule(config)

    # 处理退出信号
    def signal_handler(sig, frame):
        print("\nReceived signal, shutting down...")
        asyncio.create_task(module.stop())

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    try:
        # 启动模块
        await module.start()

        # 注册到 Module Manager
        try:
            await module.register()
        except Exception as e:
            print(f"Failed to register to Module Manager: {e}")
            print("Module will continue running without registration")

        # 保持运行
        if module.server_task:
            await module.server_task

    except Exception as e:
        print(f"Fatal error: {e}")
        await module.stop()
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
