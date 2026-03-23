"""
Memory 模块主类
实现 JSON-RPC 接口和生命周期管理
"""
import logging
import asyncio
from typing import Dict, Any, Optional, Callable
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
import uvicorn

from .config import MemoryConfig
from .types import *
from .storage.vector_store import VectorStore
from .storage.sqlite_store import SQLiteStore
from .core.short_term import ShortTermMemory
from .core.long_term import LongTermMemory
from .utils.llm_client import LLMClient
from .utils.embedding import EmbeddingClient

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class MemoryModule:
    """Memory 模块"""

    def __init__(self, config: MemoryConfig):
        self.config = config
        self.app = FastAPI(title="Memory Module")
        self.server: Optional[uvicorn.Server] = None
        self.server_task: Optional[asyncio.Task] = None

        # 初始化存储
        data_dir = Path(self.config.storage.data_dir)
        data_dir.mkdir(parents=True, exist_ok=True)

        self.embedding_client = EmbeddingClient(
            api_key=self.config.embedding.api_key,
            base_url=self.config.embedding.base_url,
            model=self.config.embedding.model,
            dimension=self.config.embedding.dimension,
        )

        self.vector_store = VectorStore(
            db_path=str(data_dir / self.config.storage.lancedb_dir),
            embedding_client=self.embedding_client,
        )

        self.sqlite_store = SQLiteStore(
            db_path=str(data_dir / self.config.storage.sqlite_file),
        )

        self.llm_client = LLMClient(
            api_key=self.config.llm.api_key,
            base_url=self.config.llm.base_url,
            model=self.config.llm.model,
        )

        # 初始化核心模块
        self.short_term = ShortTermMemory(self.vector_store, self.llm_client)
        self.long_term = LongTermMemory(self.vector_store, self.llm_client)

        # 注册路由
        self._register_routes()

    def _register_routes(self):
        """注册 JSON-RPC 路由"""
        @self.app.post("/{method}")
        async def handle_request(method: str, request: Request):
            try:
                body = await request.json()
                result = await self._dispatch(method, body.get("params", {}))
                return JSONResponse({
                    "id": body.get("id"),
                    "success": True,
                    "data": result,
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                })
            except Exception as e:
                logger.error("Request failed: %s", e, exc_info=True)
                return JSONResponse({
                    "id": body.get("id") if "body" in locals() else None,
                    "success": False,
                    "error": {
                        "code": "INTERNAL_ERROR",
                        "message": str(e),
                    },
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                }, status_code=500)

    async def _dispatch(self, method: str, params: Dict[str, Any]) -> Any:
        """分发请求到对应的处理方法"""
        handlers: Dict[str, Callable] = {
            "health": self._health,
            "shutdown": self._shutdown,
            "write_short_term": self._write_short_term,
            "search_short_term": self._search_short_term,
            "write_long_term": self._write_long_term,
            "search_long_term": self._search_long_term,
            "get_memory": self._get_memory,
            "delete_memory": self._delete_memory,
            "get_stats": self._get_stats,
            "get_reflection_watermark": self._get_reflection_watermark,
            "update_reflection_watermark": self._update_reflection_watermark,
            "update_config": self._update_config,
        }

        handler = handlers.get(method)
        if not handler:
            raise ValueError(f"Method not found: {method}")

        return await handler(params)

    async def _health(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """健康检查"""
        short_count = self.vector_store.get_short_term_count()
        long_count = self.vector_store.get_long_term_count()
        return {
            "status": "healthy",
            "details": {
                "short_term_count": short_count,
                "long_term_count": long_count,
                "total_tokens": (short_count * 100 + long_count * 500),
                "embedding_model_status": "ready",
                "llm_status": "ready",
            },
        }

    async def _shutdown(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """关闭模块"""
        logger.info("Shutdown requested")
        asyncio.create_task(self._stop_server())
        return {}

    async def _write_short_term(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """写入短期记忆"""
        write_params = WriteShortTermParams(**params)
        memory = await self.short_term.write(write_params)
        return {"memory": memory.model_dump()}

    async def _search_short_term(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """检索短期记忆"""
        search_params = SearchShortTermParams(**params)
        results = await self.short_term.search(search_params)
        return {"results": [m.model_dump() for m in results]}

    async def _write_long_term(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """写入长期记忆"""
        write_params = WriteLongTermParams(**params)
        result = await self.long_term.write(write_params)
        return {
            "action": result["action"],
            "memory": result["memory"].model_dump(),
            "merged_from": result.get("merged_from"),
        }

    async def _search_long_term(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """检索长期记忆"""
        search_params = SearchLongTermParams(**params)
        results = await self.long_term.search(search_params)
        return {
            "results": [
                {
                    "memory": r.memory.model_dump(),
                    "relevance": r.relevance,
                }
                for r in results
            ]
        }

    async def _get_memory(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """获取记忆详情"""
        import json
        from .types import GetMemoryParams, MemorySource, EntityRef

        get_params = GetMemoryParams(**params)
        result = await self.vector_store.get_by_id(get_params.memory_id)
        if result is None:
            raise ValueError(f"Memory not found: {get_params.memory_id}")

        if result["type"] == "short":
            row = result["row"]
            source_data = json.loads(row["source_json"])
            refs_data = json.loads(row["refs_json"]) if row["refs_json"] else None
            memory = ShortTermMemoryEntry(
                id=row["id"],
                content=row["content"],
                keywords=list(row["keywords"] or []),
                event_time=row["event_time"],
                persons=list(row["persons"] or []),
                entities=list(row["entities"] or []),
                topic=row["topic"] or None,
                source=MemorySource(**source_data),
                refs=refs_data,
                compressed=row["compressed"],
                visibility=row["visibility"],
                scopes=list(row["scopes"] or []),
                created_at=row["created_at"],
            )
            revisions = None
            if get_params.include_revisions:
                revisions = self.sqlite_store.get_revisions(get_params.memory_id)
            return {"memory": memory.model_dump(), "type": "short", "revisions": revisions}
        else:
            row = result["row"]
            source_data = json.loads(row["source_json"])
            entities_data = json.loads(row["entities_json"]) if row["entities_json"] else []
            memory = LongTermMemoryEntry(
                id=row["id"],
                category=row["category"],
                abstract=row["abstract"],
                overview=row["overview"],
                content=row["content"],
                entities=[EntityRef(**e) for e in entities_data],
                importance=row["importance"],
                keywords=list(row["keywords"] or []),
                tags=list(row["tags"] or []),
                source=MemorySource(**source_data),
                metadata=json.loads(row["metadata_json"]) if row["metadata_json"] else None,
                read_count=row["read_count"],
                version=row["version"],
                visibility=row["visibility"],
                scopes=list(row["scopes"] or []),
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
            revisions = None
            if get_params.include_revisions:
                revisions = self.sqlite_store.get_revisions(get_params.memory_id)
            return {"memory": memory.model_dump(), "type": "long", "revisions": revisions}

    async def _delete_memory(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """删除记忆"""
        from .types import DeleteMemoryParams

        delete_params = DeleteMemoryParams(**params)
        deleted = await self.vector_store.delete_by_id(delete_params.memory_id)
        if not deleted:
            raise ValueError(f"Memory not found: {delete_params.memory_id}")
        return {"deleted": True}

    async def _get_stats(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """获取统计信息"""
        short_stats = await self.short_term.get_stats()
        long_stats = await self.long_term.get_stats()
        return {
            "short_term": short_stats,
            "long_term": long_stats,
        }

    async def _get_reflection_watermark(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """获取反思水位"""
        watermark = self.sqlite_store.get_reflection_watermark()
        return {"last_reflected_at": watermark}

    async def _update_reflection_watermark(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """更新反思水位"""
        update_params = UpdateReflectionWatermarkParams(**params)
        self.sqlite_store.update_reflection_watermark(update_params.last_reflected_at)
        return {"last_reflected_at": update_params.last_reflected_at}

    async def _update_config(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """热更新 LLM / Embedding 配置（由 Admin 推送）"""
        updated = []

        if "llm" in params and isinstance(params["llm"], dict):
            llm = params["llm"]
            self.llm_client.reconfigure(
                api_key=llm.get("api_key"),
                base_url=llm.get("base_url"),
                model=llm.get("model"),
            )
            if llm.get("api_key") is not None:
                self.config.llm.api_key = llm["api_key"]
            if llm.get("base_url") is not None:
                self.config.llm.base_url = llm["base_url"]
            if llm.get("model") is not None:
                self.config.llm.model = llm["model"]
            updated.append("llm")

        if "embedding" in params and isinstance(params["embedding"], dict):
            emb = params["embedding"]
            self.embedding_client.reconfigure(
                api_key=emb.get("api_key"),
                base_url=emb.get("base_url"),
                model=emb.get("model"),
                dimension=emb.get("dimension"),
            )
            if emb.get("api_key") is not None:
                self.config.embedding.api_key = emb["api_key"]
            if emb.get("base_url") is not None:
                self.config.embedding.base_url = emb["base_url"]
            if emb.get("model") is not None:
                self.config.embedding.model = emb["model"]
            if emb.get("dimension") is not None:
                self.config.embedding.dimension = emb["dimension"]
            updated.append("embedding")

        logger.info("Config hot-reloaded: %s", updated)
        return {
            "updated": updated,
            "current": {
                "llm": {"model": self.config.llm.model, "base_url": self.config.llm.base_url},
                "embedding": {"model": self.config.embedding.model, "base_url": self.config.embedding.base_url, "dimension": self.config.embedding.dimension},
            },
        }

    async def start(self):
        """启动模块"""
        logger.info("Starting Memory module on port %d", self.config.port)
        config = uvicorn.Config(
            self.app,
            host="127.0.0.1",
            port=self.config.port,
            log_level="info",
        )
        self.server = uvicorn.Server(config)
        self.server_task = asyncio.create_task(self.server.serve())
        logger.info("Memory module started")

    async def _stop_server(self):
        """停止服务器"""
        await asyncio.sleep(0.5)  # 等待响应返回
        if self.server:
            self.server.should_exit = True
        if self.server_task:
            await self.server_task

    async def register(self):
        """注册到 Module Manager"""
        import httpx
        url = f"{self.config.module_manager_url}/register"
        payload = {
            "id": f"reg-{datetime.utcnow().timestamp()}",
            "source": self.config.module_id,
            "method": "register",
            "params": {
                "module_id": self.config.module_id,
                "module_type": self.config.module_type,
                "version": self.config.version,
                "protocol_version": self.config.protocol_version,
                "port": self.config.port,
                "subscriptions": [],
            },
            "timestamp": datetime.utcnow().isoformat() + "Z",
        }
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, timeout=10.0)
            resp.raise_for_status()
            logger.info("Registered to Module Manager")

    async def stop(self):
        """停止模块"""
        logger.info("Stopping Memory module")
        self.vector_store.close()
        self.sqlite_store.close()
        if self.server:
            self.server.should_exit = True
        if self.server_task:
            await self.server_task
        logger.info("Memory module stopped")
