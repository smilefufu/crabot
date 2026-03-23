"""
Memory 模块数据类型定义
对齐 protocol-memory.md 和 base-protocol.md
"""
from typing import Optional, List, Dict, Any, Literal
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
MemoryCategory = Literal["profile", "preference", "entity", "event", "case", "pattern"] | str
EntityType = Literal["friend", "project", "topic", "event", "location", "organization"]
SearchDetail = Literal["L0", "L1", "L2"]
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
# 实体引用
# ============================================================================

class EntityRef(BaseModel):
    """实体引用"""
    type: EntityType
    id: str
    name: str


# ============================================================================
# 短期记忆
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
# 长期记忆
# ============================================================================

class LongTermMemoryEntry(BaseModel):
    """长期记忆条目（完整）"""
    id: MemoryId = Field(default_factory=lambda: f"mem-l-{uuid.uuid4().hex[:12]}")
    category: MemoryCategory
    abstract: str  # L0
    overview: str  # L1
    content: str   # L2
    entities: List[EntityRef] = Field(default_factory=list)
    importance: int = 5
    keywords: List[str] = Field(default_factory=list)
    tags: List[str] = Field(default_factory=list)
    source: MemorySource
    metadata: Optional[Dict[str, Any]] = None
    read_count: int = 0
    version: int = 1

    # 权限标记
    visibility: Visibility = "public"
    scopes: List[str] = Field(default_factory=list)

    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")
    updated_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")


class LongTermL0Entry(BaseModel):
    """长期记忆 L0 级别返回"""
    id: MemoryId
    abstract: str
    importance: int
    tags: List[str]
    category: MemoryCategory
    visibility: Visibility
    created_at: str


class LongTermL1Entry(LongTermL0Entry):
    """长期记忆 L1 级别返回"""
    overview: str
    entities: List[EntityRef]
    keywords: List[str]
    source: MemorySource
    scopes: List[str]


# ============================================================================
# 修正历史
# ============================================================================

class MemoryRevision(BaseModel):
    """记忆修正历史"""
    version: int
    previous_content: str
    reason: str
    revised_at: str


# ============================================================================
# 请求/响应参数
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


class WriteShortTermResult(BaseModel):
    """写入短期记忆结果"""
    memory: ShortTermMemoryEntry


class WriteLongTermParams(BaseModel):
    """写入长期记忆参数"""
    category: MemoryCategory
    content: str
    source: MemorySource
    entities: Optional[List[EntityRef]] = None
    importance: Optional[int] = 5
    tags: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None
    visibility: Optional[Visibility] = "public"
    scopes: Optional[List[str]] = None


class WriteLongTermResult(BaseModel):
    """写入长期记忆结果"""
    action: Literal["created", "updated", "merged", "skipped"]
    memory: LongTermMemoryEntry
    merged_from: Optional[List[MemoryId]] = None


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


class SearchShortTermResult(BaseModel):
    """检索短期记忆结果"""
    results: List[ShortTermMemoryEntry]


class SearchLongTermFilter(BaseModel):
    """长期记忆过滤条件"""
    category: Optional[MemoryCategory] = None
    tags: Optional[List[str]] = None
    importance_min: Optional[int] = None
    entity_type: Optional[EntityType] = None
    entity_id: Optional[str] = None


class SearchLongTermParams(BaseModel):
    """检索长期记忆参数"""
    query: str
    detail: SearchDetail
    limit: int = 10
    min_relevance: float = 0.5
    filter: Optional[SearchLongTermFilter] = None
    min_visibility: Optional[Visibility] = "public"
    accessible_scopes: Optional[List[str]] = None


class SearchLongTermResultItem(BaseModel):
    """长期记忆检索结果项"""
    memory: LongTermL0Entry | LongTermL1Entry | LongTermMemoryEntry
    relevance: float


class SearchLongTermResult(BaseModel):
    """检索长期记忆结果"""
    results: List[SearchLongTermResultItem]


class GetMemoryParams(BaseModel):
    """获取记忆详情参数"""
    memory_id: MemoryId
    include_revisions: bool = False


class GetMemoryResult(BaseModel):
    """获取记忆详情结果"""
    memory: ShortTermMemoryEntry | LongTermMemoryEntry
    revisions: Optional[List[MemoryRevision]] = None


class UpdateMemoryParams(BaseModel):
    """更新长期记忆参数"""
    memory_id: MemoryId
    content: Optional[str] = None
    entities: Optional[List[EntityRef]] = None
    importance: Optional[int] = None
    tags: Optional[List[str]] = None
    revision_reason: str


class UpdateMemoryResult(BaseModel):
    """更新长期记忆结果"""
    memory: LongTermMemoryEntry
    version: int


class DeleteMemoryParams(BaseModel):
    """删除记忆参数"""
    memory_id: MemoryId


class DeleteMemoryResult(BaseModel):
    """删除记忆结果"""
    deleted: bool = True


class GetStatsResult(BaseModel):
    """存储统计结果"""
    short_term: "ShortTermStats"
    long_term: "LongTermStats"


class ShortTermStats(BaseModel):
    """短期记忆统计"""
    entry_count: int
    compressed_count: int
    total_tokens: int
    latest_entry_at: Optional[str]
    earliest_entry_at: Optional[str]


class LongTermStats(BaseModel):
    """长期记忆统计"""
    entry_count: int
    by_category: Dict[str, int]
    total_tokens: int
    latest_entry_at: Optional[str]
    earliest_entry_at: Optional[str]


class GetReflectionWatermarkResult(BaseModel):
    """反思水位查询结果"""
    last_reflected_at: Optional[str]


class UpdateReflectionWatermarkParams(BaseModel):
    """更新反思水位参数"""
    last_reflected_at: str


class UpdateReflectionWatermarkResult(BaseModel):
    """更新反思水位结果"""
    last_reflected_at: str


# ============================================================================
# 批量操作
# ============================================================================

class BatchWriteShortTermParams(BaseModel):
    """批量写入短期记忆参数"""
    entries: List[WriteShortTermParams]


class ErrorDetail(BaseModel):
    """错误详情"""
    code: str
    message: str
    details: Optional[Dict[str, Any]] = None


class BatchWriteShortTermResult(BaseModel):
    """批量写入短期记忆结果"""
    memories: List[ShortTermMemoryEntry]
    success_count: int
    failure_count: int
    failures: Optional[List[Dict[str, Any]]] = None


class BatchWriteLongTermParams(BaseModel):
    """批量写入长期记忆参数"""
    entries: List[WriteLongTermParams]


class BatchWriteLongTermResult(BaseModel):
    """批量写入长期记忆结果"""
    results: List[WriteLongTermResult]
    success_count: int
    failure_count: int
    failures: Optional[List[Dict[str, Any]]] = None


# ============================================================================
# 健康检查
# ============================================================================

class HealthResult(BaseModel):
    """健康检查结果"""
    status: Literal["healthy", "degraded", "unhealthy"]
    details: Optional[Dict[str, Any]] = None
