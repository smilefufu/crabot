"""
Memory 模块主类
实现 JSON-RPC 接口和生命周期管理
"""
import json
import logging
import asyncio
import os
from typing import Dict, Any, Optional, Callable
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
import uvicorn

from .config import MemoryConfig
from .types import *
from .storage.short_term_store import ShortTermStore
from .storage.sqlite_store import SQLiteStore
from .storage.scene_profile_store import SceneProfileStore
from .core.short_term import ShortTermMemory
from .utils.llm_client import LLMClient
from .long_term_v2.store import MemoryStore as LongTermV2Store
from .long_term_v2.sqlite_index import SqliteIndex as LongTermV2Index
from .long_term_v2.rpc import LongTermV2Rpc

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 同时把 INFO 及以上日志写到固定文件（stdio:inherit 不落盘，文件方便事后排查）
try:
    _data_dir = Path(os.environ.get("DATA_DIR", "./data"))
    _log_dir = _data_dir / "memory"
    _log_dir.mkdir(parents=True, exist_ok=True)
    _file_handler = logging.FileHandler(_log_dir / "memory.log", mode="a", encoding="utf-8")
    _file_handler.setLevel(logging.INFO)
    _file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.getLogger().addHandler(_file_handler)
except Exception as _e:  # noqa: BLE001
    logger.warning("memory file logger setup failed: %s", _e)


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

        self.short_term_store = ShortTermStore(
            db_path=str(data_dir / "short_term.db"),
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
            account_id=self.config.llm.account_id,
        )

        # 初始化核心模块
        self.short_term = ShortTermMemory(self.short_term_store, self.llm_client)

        self._compression_running = False

        # Long-term v2 is the only long-term backend (v1 routing removed).
        from .long_term_v2.reranker import FallbackReranker, HttpReranker
        data_root = str(data_dir / "long_term")
        self._lt_v2_store = LongTermV2Store(data_root)
        self._lt_v2_index = LongTermV2Index(str(data_dir / "long_term_v2.db"))

        rerank_url = os.environ.get("RERANK_BASE_URL")
        rerank_key = os.environ.get("RERANK_API_KEY")
        rerank_model = os.environ.get("RERANK_MODEL", "bge-reranker-v2-m3")
        if rerank_url and rerank_key:
            reranker = HttpReranker(base_url=rerank_url, api_key=rerank_key, model=rerank_model)
        else:
            reranker = FallbackReranker()

        self._lt_v2_rpc = LongTermV2Rpc(
            store=self._lt_v2_store,
            index=self._lt_v2_index,
            llm=self.llm_client,
            reranker=reranker,
        )
        logger.info("Long-term memory v2 enabled (data root: %s)", data_root)

        # 注册路由
        self._register_routes()

    def is_llm_configured(self) -> bool:
        """检查 LLM 配置是否完整"""
        return bool(
            self.config.llm.api_key and
            self.config.llm.base_url and
            self.config.llm.model
        )

    def is_configured(self) -> bool:
        """Memory v3 只依赖 LLM。embedding 子系统已移除。"""
        return self.is_llm_configured()

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
            "write_long_term": self._lt_v2_rpc.write_long_term,
            "search_long_term": self._lt_v2_rpc.search_long_term,
            "get_memory": self._lt_v2_rpc.get_memory,
            "delete_memory": self._lt_v2_rpc.delete_memory,
            "update_memory": self._lt_v2_rpc.update_long_term,
            "get_stats": self._get_stats,
            "get_reflection_watermark": self._get_reflection_watermark,
            "update_reflection_watermark": self._update_reflection_watermark,
            "update_config": self._update_config,
            "batch_write_short_term": self._batch_write_short_term,
            "export_memories": self._export_memories,
            "import_memories": self._import_memories,
            "upsert_scene_profile": self._upsert_scene_profile,
            "get_scene_profile": self._get_scene_profile,
            "list_scene_profiles": self._list_scene_profiles,
            "list_scene_profiles_by_memory": self._list_scene_profiles_by_memory,
            "delete_scene_profile": self._delete_scene_profile,
            "grep_memory": self._lt_v2_rpc.grep_memory,
            "list_recent": self._lt_v2_rpc.list_recent,
            "find_by_entity": self._lt_v2_rpc.find_by_entity,
            "find_by_tag": self._lt_v2_rpc.find_by_tag,
            "get_cases_about": self._lt_v2_rpc.get_cases_about,
            "quick_capture": self._lt_v2_rpc.quick_capture,
            "update_long_term": self._lt_v2_rpc.update_long_term,
            "run_maintenance": self._lt_v2_rpc.run_maintenance,
            "trigger_consolidation": self._lt_v2_rpc.trigger_consolidation,
            "get_evolution_mode": self._lt_v2_rpc.get_evolution_mode,
            "set_evolution_mode": self._lt_v2_rpc.set_evolution_mode,
            "promote_to_rule": self._lt_v2_rpc.promote_to_rule,
            "get_observation_pending": self._lt_v2_rpc.get_observation_pending,
            "mark_observation_pass": self._lt_v2_rpc.mark_observation_pass,
            "extend_observation_window": self._lt_v2_rpc.extend_observation_window,
            "get_confirmed_snapshot": self._lt_v2_rpc.get_confirmed_snapshot,
            "bump_lesson_use": self._lt_v2_rpc.bump_lesson_use,
            "list_entries": self._lt_v2_rpc.list_entries,
            "keyword_search": self._lt_v2_rpc.keyword_search,
            "restore_memory": self._lt_v2_rpc.restore_memory,
            "get_entry_version": self._lt_v2_rpc.get_entry_version,
            "report_task_feedback": self._lt_v2_rpc.report_task_feedback,
        }

        handler = handlers.get(method)
        if not handler:
            raise ValueError(f"Method not found: {method}")

        return await handler(params)

    async def _health(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """健康检查"""
        short_count = self.short_term_store.get_short_term_count()
        long_count = self._lt_v2_index.count_entries()
        return {
            "status": "healthy",
            "details": {
                "short_term_count": short_count,
                "long_term_count": long_count,
                "total_tokens": (short_count * 100 + long_count * 500),
                "llm_status": "ready" if self.is_llm_configured() else "not_configured",
                "configured": self.is_configured(),
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
            "configured": self.is_configured(),
            "llm_configured": self.is_llm_configured(),
            "version": self.config.version
        }

    async def _write_short_term(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """写入短期记忆"""
        if not self.is_llm_configured():
            raise ValueError("Memory module not configured. Please configure LLM settings in Admin.")
        write_params = WriteShortTermParams(**params)
        memory = await self.short_term.write(write_params)

        # 异步触发压缩检查
        count = self.short_term_store.get_short_term_count()
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
        search_params = SearchShortTermParams(**params)
        results = await self.short_term.search(search_params)
        return {"results": [m.model_dump() for m in results]}

    async def _get_stats(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """获取统计信息"""
        short_stats = await self.short_term.get_stats()
        long_count = self._lt_v2_index.count_entries()
        long_stats = {
            "entry_count": long_count,
            "total_tokens": long_count * 500,
            "latest_entry_at": None,
            "earliest_entry_at": None,
        }
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

    async def _export_memories(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """导出全量记忆。

        长期记忆现在由 long_term_v2 文件存储管理（``<DATA_DIR>/long_term/``），
        请用文件系统级备份/同步该目录；这里只负责短期记忆 + 反思水位。
        """
        short_rows = await self.short_term_store.get_all_short_term_rows()
        watermark = self.sqlite_store.get_reflection_watermark()

        return {
            "version": "1.1",
            "exported_at": datetime.utcnow().isoformat() + "Z",
            "short_term": short_rows,
            "watermark": watermark,
        }

    async def _import_memories(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """导入记忆（仅短期 + 反思水位；长期 v2 走文件系统级别的备份恢复）"""
        import_params = ImportMemoriesParams(**params)
        data = import_params.data

        version = data.get("version")
        if version not in ("1.0", "1.1"):
            raise ValueError(f"Unsupported export version: {version}")

        if import_params.mode == "replace":
            await self.short_term_store.clear_all()
            self.sqlite_store.conn.execute("DELETE FROM reflection_watermark")
            self.sqlite_store.conn.commit()

        short_count = 0
        for row in data.get("short_term", []):
            if import_params.mode == "merge":
                existing = await self.short_term_store.get_by_id(row["id"])
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
            await self.short_term_store.add_short_term(entry)
            short_count += 1

        if data.get("watermark"):
            self.sqlite_store.update_reflection_watermark(data["watermark"])

        return {
            "short_term_count": short_count,
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
                account_id=llm.get("account_id"),
            )
            if llm.get("api_key") is not None:
                self.config.llm.api_key = llm["api_key"]
            if llm.get("base_url") is not None:
                self.config.llm.base_url = llm["base_url"]
            if llm.get("model") is not None:
                self.config.llm.model = llm["model"]
            if llm.get("format") is not None:
                self.config.llm.format = llm["format"]
            if llm.get("account_id") is not None:
                self.config.llm.account_id = llm["account_id"]
            updated.append("llm")

        # v3: embedding 子系统已移除。如果 admin 仍 push 老的 embedding 字段，静默忽略。
        if "embedding" in params:
            logger.debug("ignoring deprecated 'embedding' update_config payload")

        logger.info("Config hot-reloaded: %s", updated)
        return {
            "updated": updated,
            "current": {
                "llm": {"model": self.config.llm.model, "base_url": self.config.llm.base_url},
            },
        }

    async def _upsert_scene_profile(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """写入或更新场景画像"""
        payload = dict(params)
        content = payload.get("content")
        if content is None:
            raise ValueError("Scene profile content is required")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("Scene profile content cannot be empty")
        payload["content"] = content.strip()
        if not payload.get("abstract") or not payload.get("overview"):
            if not self.is_llm_configured():
                raise ValueError("Memory module not configured. Please configure LLM settings in Admin.")
            summaries = await self.llm_client.generate_l0_l1(payload["content"])
            payload.setdefault("abstract", summaries["abstract"])
            payload.setdefault("overview", summaries["overview"])
            if not payload.get("abstract"):
                payload["abstract"] = summaries["abstract"]
            if not payload.get("overview"):
                payload["overview"] = summaries["overview"]
        profile = SceneProfile(**payload)
        out = self.scene_profile_store.upsert(profile)
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

    async def _list_scene_profiles_by_memory(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """列出引用指定长期记忆的场景画像"""
        memory_id = str(params["memory_id"]).strip()
        profiles = self.scene_profile_store.list_by_memory_id(memory_id)
        return {"profiles": [p.model_dump() for p in profiles]}

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
        # trust_env=False：内部 RPC 是回环地址，强制不读 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY，
        # 避免系统代理把 localhost:19000 当外网拦截后回 502 Bad Gateway。
        async with httpx.AsyncClient(trust_env=False) as client:
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
            # trust_env=False：admin endpoint 也是回环，统一不读环境代理变量。
            async with httpx.AsyncClient(trust_env=False) as client:
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
        self.short_term_store.close()
        self.sqlite_store.close()
        self.scene_profile_store.close()
        if self.server:
            self.server.should_exit = True
        if self.server_task:
            await self.server_task
        logger.info("Memory module stopped")
