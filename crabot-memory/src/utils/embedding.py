"""
Embedding 客户端 - 使用 OpenAI 兼容 API 远程调用
替代 SimpleMem 的本地 SentenceTransformers
"""
import logging
from typing import List, Optional

from openai import AsyncOpenAI

logger = logging.getLogger(__name__)


class EmbeddingClient:
    """异步 Embedding 客户端，使用 OpenAI 兼容 API"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        dimension: int = 1536,
    ):
        self._api_key = api_key
        self._base_url = base_url
        self._model = model or "text-embedding-3-small"
        self.dimension = dimension
        self._client: Optional[AsyncOpenAI] = None

    def reconfigure(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        dimension: Optional[int] = None,
    ) -> None:
        """热更新配置，下次调用时自动重建客户端"""
        if api_key is not None:
            self._api_key = api_key
        if base_url is not None:
            self._base_url = base_url
        if model is not None:
            self._model = model
        if dimension is not None:
            self.dimension = dimension
        self._client = None
        logger.info("EmbeddingClient reconfigured: model=%s base_url=%s dim=%d", self._model, self._base_url, self.dimension)

    def _ensure_client(self) -> AsyncOpenAI:
        if self._client is None:
            self._client = AsyncOpenAI(
                api_key=self._api_key,
                base_url=self._base_url,
            )
        return self._client

    async def embed(self, texts: List[str]) -> List[List[float]]:
        """批量生成 embedding 向量"""
        if not texts:
            return []

        client = self._ensure_client()
        try:
            resp = await client.embeddings.create(
                model=self._model,
                input=texts,
            )
            return [item.embedding for item in resp.data]
        except Exception as e:
            logger.error("Embedding failed: %s", e)
            raise

    async def embed_single(self, text: str) -> List[float]:
        """单条文本 embedding"""
        results = await self.embed([text])
        return results[0]
