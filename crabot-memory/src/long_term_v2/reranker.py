"""Step 3: Cross-encoder rerank — pluggable client with passthrough fallback."""
import logging
from typing import Any, List, Tuple

import httpx

logger = logging.getLogger(__name__)


class FallbackReranker:
    """Order-preserving passthrough used when no provider is configured / fails."""

    async def rerank_async(
        self, query: str, docs: List[str], top_n: int,
    ) -> List[Tuple[int, float]]:
        return [(i, 1.0 / (i + 1)) for i in range(min(top_n, len(docs)))]


class HttpReranker:
    """Generic OpenAI-compatible rerank HTTP client (Voyage / SiliconFlow / BGE-server)."""

    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    async def rerank_async(
        self, query: str, docs: List[str], top_n: int,
    ) -> List[Tuple[int, float]]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                f"{self.base_url}/rerank",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={"model": self.model, "query": query, "documents": docs, "top_n": top_n},
            )
            resp.raise_for_status()
            data = resp.json()
        results = data.get("results") or data.get("data") or []
        return [(int(r["index"]), float(r.get("relevance_score", r.get("score", 0.0))))
                for r in results]


async def rerank(
    query: str, docs: List[str], top_n: int, client: Any,
) -> List[Tuple[str, float]]:
    """Return docs reordered by rerank score (top_n only); falls back to passthrough on error."""
    if not docs:
        return []
    try:
        ranked = await client.rerank_async(query, docs, top_n)
    except Exception as e:  # noqa: BLE001
        logger.warning("rerank failed (%s) — passthrough fallback", e)
        ranked = [(i, 1.0 / (i + 1)) for i in range(min(top_n, len(docs)))]
    return [(docs[i], s) for i, s in ranked[:top_n]]
