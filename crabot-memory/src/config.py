"""
Memory 模块配置
"""
from typing import Literal, Optional
from pydantic import BaseModel, Field
import os
import yaml


LLMFormat = Literal["openai", "anthropic", "gemini", "openai-responses"]


class LLMConfig(BaseModel):
    """LLM 配置"""
    api_key: str = ""  # 允许空值，但标记为未配置
    base_url: str = ""
    model: str = ""
    format: LLMFormat = "openai"
    # 仅 openai-responses + ChatGPT 订阅 OAuth 时使用：用作 ChatGPT-Account-Id header
    account_id: str = ""
    temperature: float = 0.1
    max_retries: int = 3


class StorageConfig(BaseModel):
    """存储配置"""
    data_dir: str = "./data/memory"
    sqlite_file: str = "metadata.db"


class DedupConfig(BaseModel):
    """去重配置"""
    similarity_threshold: float = 0.85
    max_candidates: int = 3


class CompressionConfig(BaseModel):
    """压缩配置"""
    compression_threshold: int = 100
    compression_token_threshold: int = 50000
    retention_window_days: int = 3
    max_retention_days: int = 30
    window_size: int = 20


class RetrievalConfig(BaseModel):
    """检索配置"""
    semantic_top_k: int = 10
    keyword_top_k: int = 10
    enable_planning: bool = True


class MemoryConfig(BaseModel):
    """Memory 模块完整配置"""
    module_id: str = "memory-default"
    module_type: str = "memory"
    version: str = "0.1.0"
    protocol_version: str = "0.2.0"
    port: int = 19002
    module_manager_url: str = "http://localhost:19000"
    admin_endpoint: str = ""  # Admin RPC 地址，供启动时 pull 配置

    llm: LLMConfig = Field(default_factory=LLMConfig)
    storage: StorageConfig = Field(default_factory=StorageConfig)
    dedup: DedupConfig = Field(default_factory=DedupConfig)
    compression: CompressionConfig = Field(default_factory=CompressionConfig)
    retrieval: RetrievalConfig = Field(default_factory=RetrievalConfig)


def load_config(config_path: Optional[str] = None) -> MemoryConfig:
    """加载配置，优先级：环境变量 > 配置文件 > 默认值"""
    config = MemoryConfig()

    # 从 YAML 文件加载
    if config_path and os.path.exists(config_path):
        with open(config_path, "r") as f:
            data = yaml.safe_load(f) or {}
        config = MemoryConfig(**data)

    # 环境变量覆盖关键配置
    if v := os.environ.get("CRABOT_MEMORY_PORT"):
        config.port = int(v)
    # 兼容 Module Manager 注入的标准端口变量（优先级更高）
    if v := os.environ.get("Crabot_PORT"):
        config.port = int(v)
    if v := os.environ.get("CRABOT_MODULE_MANAGER_URL"):
        config.module_manager_url = v
    if v := os.environ.get("CRABOT_ADMIN_ENDPOINT"):
        config.admin_endpoint = v
    if v := os.environ.get("CRABOT_LLM_API_KEY"):
        config.llm.api_key = v
    if v := os.environ.get("CRABOT_LLM_BASE_URL"):
        config.llm.base_url = v
    if v := os.environ.get("CRABOT_LLM_MODEL"):
        config.llm.model = v
    if v := os.environ.get("CRABOT_LLM_FORMAT"):
        config.llm.format = v
    if v := os.environ.get("CRABOT_LLM_ACCOUNT_ID"):
        config.llm.account_id = v
    # CRABOT_EMBEDDING_* env vars 在 v3 已废弃，启动时静默忽略（兼容老 admin push）
    if v := os.environ.get("CRABOT_MEMORY_DATA_DIR"):
        config.storage.data_dir = v

    # 不验证必填字段，允许启动
    # 配置完整性由 is_configured() 方法检查

    return config
