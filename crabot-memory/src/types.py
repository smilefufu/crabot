"""
Memory 模块数据类型定义
对齐 protocol-memory.md 和 base-protocol.md
"""
from typing import Optional, List, Dict, Any, Literal, Union
from pydantic import BaseModel, Field
from datetime import datetime
import uuid


# ============================================================================
# 基础类型
# ============================================================================

MemoryId = str
ModuleId = str
TaskId = str
SessionId = str
FriendId = str

MemoryLevel = Literal["short_term", "long_term"]
Visibility = Literal["private", "internal", "public"]


# ============================================================================
# 来源信息
# ============================================================================

class MemorySource(BaseModel):
    """记忆来源信息"""
    type: Literal["conversation", "reflection", "manual", "system"]
    task_id: Optional[TaskId] = None
    channel_id: Optional[ModuleId] = None
    session_id: Optional[SessionId] = None
    original_time: Optional[str] = None


# ============================================================================
# 短期记忆
#
# 注意：长期记忆 v1 的类型/接口已在 Memory v2 Phase 4 移除。长期记忆现由
# ``src/long_term_v2/`` 提供（文件存储 + SQLite 索引），其类型在
# ``src/long_term_v2/schema.py`` 定义。
# ============================================================================

class ShortTermMemoryEntry(BaseModel):
    """短期记忆条目"""
    id: MemoryId = Field(default_factory=lambda: f"mem-s-{uuid.uuid4().hex[:12]}")
    content: str
    keywords: List[str] = Field(default_factory=list)
    event_time: str
    persons: List[str] = Field(default_factory=list)
    entities: List[str] = Field(default_factory=list)
    topic: Optional[str] = None
    source: MemorySource
    refs: Optional[Dict[str, str]] = None
    compressed: bool = False

    # 权限标记
    visibility: Visibility = "public"
    scopes: List[str] = Field(default_factory=list)

    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")


# ============================================================================
# 请求/响应参数（短期）
# ============================================================================

class WriteShortTermParams(BaseModel):
    """写入短期记忆参数"""
    content: str
    source: MemorySource
    event_time: Optional[str] = None
    refs: Optional[Dict[str, str]] = None
    keywords: Optional[List[str]] = None
    persons: Optional[List[str]] = None
    entities: Optional[List[str]] = None
    topic: Optional[str] = None
    visibility: Optional[Visibility] = "public"
    scopes: Optional[List[str]] = None


class TimeRange(BaseModel):
    """时间范围"""
    start: Optional[str] = None
    end: Optional[str] = None


class SearchShortTermFilter(BaseModel):
    """短期记忆过滤条件"""
    persons: Optional[List[str]] = None
    entities: Optional[List[str]] = None
    topic: Optional[str] = None
    refs: Optional[Dict[str, str]] = None


class SearchShortTermParams(BaseModel):
    """检索短期记忆参数"""
    query: Optional[str] = None
    time_range: Optional[TimeRange] = None
    filter: Optional[SearchShortTermFilter] = None
    sort_by: Literal["event_time", "relevance"] = "event_time"
    limit: int = 20
    min_visibility: Optional[Visibility] = "public"
    accessible_scopes: Optional[List[str]] = None


class UpdateReflectionWatermarkParams(BaseModel):
    """更新反思水位参数"""
    last_reflected_at: str


# ============================================================================
# 批量操作（短期）
# ============================================================================

class BatchWriteShortTermParams(BaseModel):
    """批量写入短期记忆参数"""
    entries: List[WriteShortTermParams]


# ============================================================================
# 导入/导出
# ============================================================================

class ImportMemoriesParams(BaseModel):
    """导入参数"""
    mode: Literal["replace", "merge"]
    data: Dict[str, Any]


# ============================================================================
# 健康检查
# ============================================================================

class HealthResult(BaseModel):
    """健康检查结果"""
    status: Literal["healthy", "degraded", "unhealthy"]
    details: Optional[Dict[str, Any]] = None


# ============================================================================
# 场景画像（SceneProfile）— protocol-memory.md v0.2.0
# ============================================================================


class SceneIdentityFriend(BaseModel):
    """场景身份：好友"""
    type: Literal["friend"] = "friend"
    friend_id: str


class SceneIdentityGroup(BaseModel):
    """场景身份：群会话"""
    type: Literal["group_session"] = "group_session"
    channel_id: str
    session_id: str


class SceneIdentityGlobal(BaseModel):
    """场景身份：全局（Agent 基础 persona）"""
    type: Literal["global"] = "global"


SceneIdentity = Union[SceneIdentityFriend, SceneIdentityGroup, SceneIdentityGlobal]


class SceneProfile(BaseModel):
    """场景画像（按场景身份聚合的稳定规则与信息）"""
    scene: SceneIdentity
    label: str
    abstract: str
    overview: str
    content: str
    source_memory_ids: Optional[List[MemoryId]] = None
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")
    updated_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")
    last_declared_at: Optional[str] = None
