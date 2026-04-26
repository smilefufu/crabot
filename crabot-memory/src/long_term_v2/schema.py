"""Long-term memory v2 schema."""
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Literal, Union, get_args
from pydantic import BaseModel, Field, field_validator, model_validator


FactMaturity = Literal["observed", "confirmed", "stale"]
# lesson maturity:
#   - "case"  : single occurrence (UI: 单次)
#   - "rule"  : general rule synthesized from ≥3 same-scenario cases (UI: 通用经验)
#   - "retired": deprecated rule (UI: 已退休)
LessonMaturity = Literal["case", "rule", "retired"]
ConceptMaturity = Literal["draft", "established"]
Maturity = Union[FactMaturity, LessonMaturity, ConceptMaturity]

MemType = Literal["fact", "lesson", "concept"]
EntityType = Literal["friend", "project", "topic", "event", "location", "organization"]

_TYPE_MATURITY: dict = {
    "fact": set(get_args(FactMaturity)),
    "lesson": set(get_args(LessonMaturity)),
    "concept": set(get_args(ConceptMaturity)),
}

# Fresh writes start at the earliest maturity of each type.
# Migrated writes come from v1 (already reflected) so get a more mature default.
_DEFAULT_MATURITY_FRESH: dict = {"fact": "observed", "lesson": "case", "concept": "draft"}
_DEFAULT_MATURITY_MIGRATED: dict = {"fact": "confirmed", "lesson": "case", "concept": "established"}


def default_maturity_fresh(type_: str) -> str:
    return _DEFAULT_MATURITY_FRESH[type_]


def default_maturity_migrated(type_: str) -> str:
    return _DEFAULT_MATURITY_MIGRATED[type_]


def new_memory_id() -> str:
    return f"mem-l-{uuid.uuid4().hex[:12]}"


def utc_now_iso_z() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class EntityRef(BaseModel):
    type: EntityType
    id: str
    name: str


class SourceRef(BaseModel):
    type: Literal["conversation", "reflection", "manual", "system"]
    task_id: Optional[str] = None
    session_id: Optional[str] = None
    channel_id: Optional[str] = None
    trace_id: Optional[str] = None


class ImportanceFactors(BaseModel):
    proximity: float = Field(ge=0, le=1)
    surprisal: float = Field(ge=0, le=1)
    entity_priority: float = Field(ge=0, le=1)
    unambiguity: float = Field(ge=0, le=1)


class LessonMeta(BaseModel):
    scenario: str = ""
    outcome: Literal["success", "failure"] = "success"
    # ID list of source cases this rule was synthesized from (≥3 required).
    source_cases: List[str] = Field(default_factory=list)
    use_count: int = 0
    last_validated_at: Optional[str] = None


class Observation(BaseModel):
    """Observation window metadata. Confirmed entries (rules / new fact / new concept)
    enter a 7-day observation period during which user feedback (pass/fail) decides
    whether they stay, get rolled back, or get extended.

    Fields are intentionally short here; SQL columns and RPC payloads use the
    `observation_*` prefix to avoid ambiguity at the wire/DB layer.
    """
    started_at: str
    window_days: int = 7
    outcome: Literal["pass", "fail", "pending"] = "pending"
    last_seen_at: Optional[str] = None
    stale_check_count: int = 0


class MemoryFrontmatter(BaseModel):
    id: str
    type: MemType
    maturity: Maturity
    brief: str = Field(max_length=80)
    author: str
    source_ref: SourceRef
    source_trust: int = Field(ge=1, le=5)
    content_confidence: int = Field(ge=1, le=5)
    importance_factors: ImportanceFactors
    entities: List[EntityRef] = Field(default_factory=list)
    tags: List[str] = Field(default_factory=list)
    event_time: str
    ingestion_time: str
    invalidated_by: Optional[str] = None
    lesson_meta: Optional[LessonMeta] = None
    observation: Optional[Observation] = None
    version: int = 1
    prev_version_ids: List[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_maturity_matches_type(self) -> "MemoryFrontmatter":
        allowed = _TYPE_MATURITY.get(self.type, set())
        if self.maturity not in allowed:
            raise ValueError(
                f"maturity '{self.maturity}' invalid for type '{self.type}'; "
                f"allowed: {sorted(allowed)}"
            )
        return self

    @field_validator("brief")
    @classmethod
    def _brief_nonempty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("brief must not be empty")
        return v


class MemoryEntry(BaseModel):
    frontmatter: MemoryFrontmatter
    body: str = ""
