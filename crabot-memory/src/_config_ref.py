"""
配置引用辅助模块
用于在 llm_client 中获取配置
"""
from typing import Optional

_llm_config: Optional[dict] = None


def set_llm_config(config: dict):
    """设置 LLM 配置"""
    global _llm_config
    _llm_config = config


def get_llm_config() -> dict:
    """获取 LLM 配置"""
    return _llm_config or {}
