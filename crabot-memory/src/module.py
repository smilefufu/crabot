"""
Memory 模块主类
实现 JSON-RPC 接口和生命周期管理
"""
import json
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
from .storage.scene_profile_store import SceneProfileStore
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

        self.scene_profile_store = SceneProfileStore(
            db_path=str(data_dir / self.config.storage.sqlite_file),
        )

        self.llm_client = LLMClient(
            api_key=self.config.llm.api_key,
            base_url=self.config.llm.base_url,
            model=self.config.llm.model,
            format=self.config.llm.format,
        )

        # 初始化核心模块
        self.short_term = ShortTermMemory(self.vector_store, self.llm_client)
        self.long_term = LongTermMemory(self.vector_store, self.llm_client, self.sqlite_store, self.config.dedup)

        self._compression_running = False

        # 注册路由
        self._register_routes()

    def is_llm_configured(self) -> bool:
        """检查 LLM 配置是否完整"""
        return bool(
            self.config.llm.api_key and
            self.config.llm.base_url and
            self.config.llm.model
        )

    def is_embedding_configured(self) -> bool:
        """检查 Embedding 配置是否完整"""
        return bool(
            self.config.embedding.api_key and
            self.config.embedding.base_url and
            self.config.embedding.model
        )

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
            "get_status": self._get_status,
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
            "update_memory": self._update_memory,
            "batch_write_short_term": self._batch_write_short_term,
            "batch_write_long_term": self._batch_write_long_term,
            "export_memories": self._export_memories,
            "import_memories": self._import_memories,
            "upsert_scene_profile": self._upsert_scene_profile,
            "patch_scene_profile": self._patch_scene_profile,
            "get_scene_profile": self._get_scene_profile,
            "list_scene_profiles": self._list_scene_profiles,
            "delete_scene_profile": self._delete_scene_profile,
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
                "embedding_model_status": "ready" if self.is_embedding_configured() else "not_configured",
                "llm_status": "ready" if self.is_llm_configured() else "not_configured",
                "configured": self.is_llm_configured() and self.is_embedding_configured(),
            },
        }

    async def _shutdown(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """关闭模块"""
        logger.info("Shutdown requested")
        asyncio.create_task(self._stop_server())
        return {}

    async def _get_status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """获取配置状态"""
        return {
            "configured": self.is_llm_configured() and self.is_embedding_configured(),
            "llm_configured": self.is_llm_configured(),
            "embedding_configured": self.is_embedding_configured(),
            "version": self.config.version
        }

    async def _write_short_term(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """写入短期记忆"""
        if not self.is_llm_configured():
            raise ValueError("Memory module not configured. Please configure LLM settings in Admin.")
        write_params = WriteShortTermParams(**params)
        memory = await self.short_term.write(write_params)

        # 异步触发压缩检查
        count = self.vector_store.get_short_term_count()
        if count > self.config.compression.compression_threshold and not self._compression_running:
            asyncio.create_task(self._run_compression())

        return {"memory": memory.model_dump()}

    async def _run_compression(self):
        """后台执行压缩 + rotate"""
        if self._compression_running:
            return
        self._compression_running = True
        try:
            await self.short_term.compress(self.config.compression)
            await self.short_term.rotate(self.config.compression)
        except Exception as e:
            logger.error("Compression failed: %s", e, exc_info=True)
        finally:
            self._compression_running = False

    async def _search_short_term(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """检索短期记忆"""
        if not self.is_embedding_configured():
            raise ValueError("Memory module not configured. Please configure Embedding settings in Admin.")
        search_params = SearchShortTermParams(**params)
        results = await self.short_term.search(search_params)
        return {"results": [m.model_dump() for m in results]}

    async def _write_long_term(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """写入长期记忆"""
        if not self.is_llm_configured():
            raise ValueError("Memory module not configured. Please configure LLM settings in Admin.")
        write_params = WriteLongTermParams(**params)
        result = await self.long_term.write(write_params)
        return {
            "action": result["action"],
            "memory": result["memory"].model_dump(),
            "merged_from": result.get("merged_from"),
        }

    async def _search_long_term(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """检索长期记忆"""
        if not self.is_embedding_configured():
            raise ValueError("Memory module not configured. Please configure Embedding settings in Admin.")
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
                revisions = [r.model_dump() for r in self.sqlite_store.get_revisions(get_params.memory_id)]
            return {"memory": memory.model_dump(), "type": "short", "revisions": revisions}
        else:
            row = result["row"]
            source_data = json.loads(row["source_json"])
            entities_data = json.loads(row["entities_json"]) if row["entities_json"] else []
            memory = LongTermMemoryEntry(
                id=row["id"],
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
                revisions = [r.model_dump() for r in self.sqlite_store.get_revisions(get_params.memory_id)]
            return {"memory": memory.model_dump(), "type": "long", "revisions": revisions}

    async def _delete_memory(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """删除记忆"""
        delete_params = DeleteMemoryParams(**params)
        deleted = await self.vector_store.delete_by_id(delete_params.memory_id)
        if not deleted:
            raise ValueError(f"Memory not found: {delete_params.memory_id}")
        return {"deleted": True}

    async def _update_memory(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """更新长期记忆"""
        update_params = UpdateMemoryParams(**params)
        result = await self.long_term.update(update_params)
        return {
            "memory": result["memory"].model_dump(),
            "version": result["version"],
        }

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

    async def _batch_write_short_term(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """批量写入短期记忆"""
        batch_params = BatchWriteShortTermParams(**params)
        memories = []
        failures = []
        for i, entry_params in enumerate(batch_params.entries):
            try:
                result = await self._write_short_term(entry_params.model_dump())
                memories.append(result["memory"])
            except Exception as e:
                failures.append({"index": i, "error": {"code": "MEMORY_WRITE_FAILED", "message": str(e)}})
        return {
            "memories": memories,
            "success_count": len(memories),
            "failure_count": len(failures),
            "failures": failures if failures else None,
        }

    async def _batch_write_long_term(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """批量写入长期记忆"""
        batch_params = BatchWriteLongTermParams(**params)
        results = []
        failures = []
        for i, entry_params in enumerate(batch_params.entries):
            try:
                result = await self._write_long_term(entry_params.model_dump())
                results.append(result)
            except Exception as e:
                failures.append({"index": i, "error": {"code": "MEMORY_WRITE_FAILED", "message": str(e)}})
        return {
            "results": results,
            "success_count": len(results),
            "failure_count": len(failures),
            "failures": failures if failures else None,
        }

    async def _export_memories(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """导出全量记忆"""
        short_rows = await self.vector_store.get_all_short_term_rows()
        long_rows = await self.vector_store.get_all_long_term_rows()
        watermark = self.sqlite_store.get_reflection_watermark()

        revisions = []
        for row in long_rows:
            mem_revisions = self.sqlite_store.get_revisions(row["id"])
            for rev in mem_revisions:
                revisions.append({
                    "memory_id": row["id"],
                    **rev.model_dump(),
                })

        return {
            "version": "1.0",
            "exported_at": datetime.utcnow().isoformat() + "Z",
            "short_term": short_rows,
            "long_term": long_rows,
            "watermark": watermark,
            "revisions": revisions,
        }

    async def _import_memories(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """导入记忆"""
        import_params = ImportMemoriesParams(**params)
        data = import_params.data

        if data.get("version") != "1.0":
            raise ValueError(f"Unsupported export version: {data.get('version')}")

        if import_params.mode == "replace":
            await self.vector_store.clear_all()
            self.sqlite_store.conn.execute("DELETE FROM memory_revisions")
            self.sqlite_store.conn.execute("DELETE FROM reflection_watermark")
            self.sqlite_store.conn.commit()

        short_count = 0
        for row in data.get("short_term", []):
            if import_params.mode == "merge":
                existing = await self.vector_store.get_by_id(row["id"])
                if existing:
                    continue
            source_data = json.loads(row["source_json"]) if isinstance(row.get("source_json"), str) else row.get("source_json", {})
            entry = ShortTermMemoryEntry(
                id=row["id"], content=row["content"],
                keywords=list(row.get("keywords") or []),
                event_time=row["event_time"],
                persons=list(row.get("persons") or []),
                entities=list(row.get("entities") or []),
                topic=row.get("topic") or None,
                source=MemorySource(**source_data) if source_data else MemorySource(type="system"),
                refs=json.loads(row["refs_json"]) if isinstance(row.get("refs_json"), str) and row["refs_json"] else None,
                compressed=row.get("compressed", False),
                visibility=row.get("visibility", "public"),
                scopes=list(row.get("scopes") or []),
                created_at=row.get("created_at", ""),
            )
            await self.vector_store.add_short_term(entry)
            short_count += 1

        long_count = 0
        for row in data.get("long_term", []):
            if import_params.mode == "merge":
                existing = await self.vector_store.get_by_id(row["id"])
                if existing:
                    continue
            source_data = json.loads(row["source_json"]) if isinstance(row.get("source_json"), str) else row.get("source_json", {})
            entities_data = json.loads(row["entities_json"]) if isinstance(row.get("entities_json"), str) else row.get("entities_json", [])
            metadata_data = json.loads(row["metadata_json"]) if isinstance(row.get("metadata_json"), str) and row["metadata_json"] else None
            entry = LongTermMemoryEntry(
                id=row["id"], abstract=row["abstract"], overview=row["overview"],
                content=row["content"],
                entities=[EntityRef(**e) for e in entities_data],
                importance=row.get("importance", 5),
                keywords=list(row.get("keywords") or []),
                tags=list(row.get("tags") or []),
                source=MemorySource(**source_data) if source_data else MemorySource(type="system"),
                metadata=metadata_data,
                read_count=row.get("read_count", 0),
                version=row.get("version", 1),
                visibility=row.get("visibility", "public"),
                scopes=list(row.get("scopes") or []),
                created_at=row.get("created_at", ""),
                updated_at=row.get("updated_at", ""),
            )
            await self.vector_store.add_long_term(entry)  # re-embeds on L0 abstract
            long_count += 1

        if data.get("watermark"):
            self.sqlite_store.update_reflection_watermark(data["watermark"])

        for rev in data.get("revisions", []):
            try:
                self.sqlite_store.add_revision(
                    rev["memory_id"], rev["version"], rev["previous_content"], rev["reason"],
                )
            except Exception:
                pass

        return {
            "short_term_count": short_count,
            "long_term_count": long_count,
            "watermark_restored": data.get("watermark") is not None,
        }

    async def _update_config(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """热更新 LLM / Embedding 配置（由 Admin 推送）"""
        updated = []

        if "llm" in params and isinstance(params["llm"], dict):
            llm = params["llm"]
            self.llm_client.reconfigure(
                api_key=llm.get("api_key"),
                base_url=llm.get("base_url"),
                model=llm.get("model"),
                format=llm.get("format"),
            )
            if llm.get("api_key") is not None:
                self.config.llm.api_key = llm["api_key"]
            if llm.get("base_url") is not None:
                self.config.llm.base_url = llm["base_url"]
            if llm.get("model") is not None:
                self.config.llm.model = llm["model"]
            if llm.get("format") is not None:
                self.config.llm.format = llm["format"]
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
            # 维度可能变了，让 VectorStore 下次操作时重新校验
            if emb.get("model") is not None or emb.get("dimension") is not None:
                self.vector_store._tables_initialized = False
            updated.append("embedding")

        logger.info("Config hot-reloaded: %s", updated)
        return {
            "updated": updated,
            "current": {
                "llm": {"model": self.config.llm.model, "base_url": self.config.llm.base_url},
                "embedding": {"model": self.config.embedding.model, "base_url": self.config.embedding.base_url, "dimension": self.config.embedding.dimension},
            },
        }

    async def _upsert_scene_profile(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """写入或更新场景画像"""
        profile = SceneProfile(**params)
        out = self.scene_profile_store.upsert(profile)
        return {"profile": out.model_dump()}

    async def _patch_scene_profile(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """局部更新场景画像"""
        scene = self._parse_scene(params["scene"])
        section = SceneProfileSection(**params["section"])
        merge = params.get("merge", "replace_topic")
        label = params.get("label")
        out = self.scene_profile_store.patch(scene, label=label, section=section, merge=merge)
        return {"profile": out.model_dump()}

    async def _get_scene_profile(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """获取场景画像"""
        scene = self._parse_scene(params["scene"])
        only_public = bool(params.get("only_public", False))
        out = self.scene_profile_store.get(scene, only_public=only_public)
        return {"profile": out.model_dump() if out else None}

    async def _list_scene_profiles(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """列出场景画像"""
        out = self.scene_profile_store.list(
            scene_type=params.get("scene_type"),
            limit=int(params.get("limit", 100)),
            offset=int(params.get("offset", 0)),
        )
        return {"profiles": [p.model_dump() for p in out]}

    async def _delete_scene_profile(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """删除场景画像"""
        scene = self._parse_scene(params["scene"])
        deleted = self.scene_profile_store.delete(scene)
        return {"deleted": deleted}

    def _parse_scene(self, raw: Dict[str, Any]) -> SceneIdentity:
        """将 dict 转为 SceneIdentity 联合类型"""
        t = raw.get("type")
        if t == "friend":
            return SceneIdentityFriend(friend_id=raw["friend_id"])
        if t == "group_session":
            return SceneIdentityGroup(channel_id=raw["channel_id"], session_id=raw["session_id"])
        if t == "global":
            return SceneIdentityGlobal()
        raise ValueError(f"Unknown scene type: {t}")

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

    async def pull_config_from_admin(self):
        """启动时从 Admin 拉取初始配置（统一配置模式：pull 初始化 + push 更新）"""
        if not self.config.admin_endpoint:
            logger.warning("Admin endpoint not configured, skipping config pull")
            return

        import httpx
        url = f"{self.config.admin_endpoint}/get_memory_config"
        payload = {
            "id": f"pull-{datetime.utcnow().timestamp()}",
            "source": self.config.module_id,
            "method": "get_memory_config",
            "params": {"instance_id": self.config.module_id},
            "timestamp": datetime.utcnow().isoformat() + "Z",
        }
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(url, json=payload, timeout=10.0)
                resp.raise_for_status()
                data = resp.json()
                config = data.get("data", {}).get("config", {})
                if config:
                    result = await self._update_config(config)
                    logger.info("Pulled initial config from Admin: %s", result.get("updated", []))
                else:
                    logger.info("Admin returned empty config, using env defaults")
        except Exception as e:
            logger.warning("Failed to pull config from Admin: %s", e)
            logger.info("Continuing with env-injected config")

    async def stop(self):
        """停止模块"""
        logger.info("Stopping Memory module")
        self.vector_store.close()
        self.sqlite_store.close()
        self.scene_profile_store.close()
        if self.server:
            self.server.should_exit = True
        if self.server_task:
            await self.server_task
        logger.info("Memory module stopped")
