"""单元测试 v1 record → v2 entry 转换。"""
from src.long_term_v2.schema import MemoryEntry, default_maturity_migrated
from upgrade.from_v1_to_v2 import migrate_record, infer_type


def test_infer_type_lesson_by_tag():
    assert infer_type({"tags": ["lesson", "x"]}, default="concept") == "lesson"
    assert infer_type({"tags": ["task_experience"]}, default="concept") == "lesson"


def test_infer_type_fact_by_entity():
    assert infer_type({"entities": [{"id": "z3"}]}, default="concept") == "fact"


def test_infer_type_default_when_no_signal():
    assert infer_type({}, default="concept") == "concept"


def test_default_maturity():
    assert default_maturity_migrated("fact") == "confirmed"
    assert default_maturity_migrated("lesson") == "case"
    assert default_maturity_migrated("concept") == "established"


def test_migrate_record_basic_fact():
    old = {
        "id": "mem-l-old1",
        "abstract": "张三的微信号",
        "overview": "比较短的概览",
        "content": "wxid_xxx 详细内容",
        "importance": 8,
        "entities": [{"type": "friend", "id": "z3", "name": "张三"}],
        "tags": ["#contact"],
        "source": {"type": "conversation", "task_id": "t1"},
        "read_count": 3,
        "version": 2,
        "created_at": "2026-01-01T10:00:00Z",
        "updated_at": "2026-02-01T10:00:00Z",
    }
    entry, warnings = migrate_record(old)
    assert isinstance(entry, MemoryEntry)
    assert entry.frontmatter.id == "mem-l-old1"
    assert entry.frontmatter.type == "fact"
    assert entry.frontmatter.maturity == "confirmed"
    assert entry.frontmatter.brief == "张三的微信号"
    assert entry.frontmatter.importance_factors.proximity == 0.8
    assert entry.body == "wxid_xxx 详细内容"
    assert entry.frontmatter.event_time == "2026-01-01T10:00:00Z"
    assert entry.frontmatter.ingestion_time == "2026-02-01T10:00:00Z"


def test_migrate_record_truncates_long_brief():
    old = {
        "id": "mem-l-long",
        "abstract": "a" * 100,
        "overview": "x",
        "content": "body",
        "importance": 5,
        "entities": [],
        "tags": [],
        "source": {"type": "manual"},
        "read_count": 0,
        "version": 1,
        "created_at": "2026-01-01T10:00:00Z",
        "updated_at": "2026-01-01T10:00:00Z",
    }
    entry, warnings = migrate_record(old)
    assert len(entry.frontmatter.brief) == 80
    assert any("truncated" in w for w in warnings)


def test_migrate_record_warns_overview_too_long():
    old = {
        "id": "mem-l-ov",
        "abstract": "brief",
        "overview": "X" * 200,
        "content": "Y" * 100,
        "importance": 5,
        "entities": [],
        "tags": [],
        "source": {"type": "manual"},
        "read_count": 0,
        "version": 1,
        "created_at": "2026-01-01T10:00:00Z",
        "updated_at": "2026-01-01T10:00:00Z",
    }
    entry, warnings = migrate_record(old)
    assert any("overview" in w.lower() for w in warnings)


def test_migrate_record_reads_entities_json_string():
    """Production v1 stores entities as JSON string (entities_json), not dict."""
    old = {
        "id": "mem-l-prod1",
        "abstract": "张三的微信号",
        "overview": "",
        "content": "wxid_xxx",
        "importance": 6,
        "entities_json": '[{"type":"friend","id":"z3","name":"张三"}]',
        "tags": [],
        "source_json": '{"type":"conversation","task_id":"t1","session_id":"s1","channel_id":"wx1"}',
        "read_count": 0,
        "version": 1,
        "created_at": "2026-01-01T10:00:00Z",
        "updated_at": "2026-01-01T10:00:00Z",
    }
    entry, warnings = migrate_record(old)
    # entities_json populated → type=fact via entity inference
    assert entry.frontmatter.type == "fact"
    assert len(entry.frontmatter.entities) == 1
    assert entry.frontmatter.entities[0].name == "张三"
    # source_json populated → source_ref preserves task/session/channel
    assert entry.frontmatter.source_ref.type == "conversation"
    assert entry.frontmatter.source_ref.task_id == "t1"
    assert entry.frontmatter.source_ref.session_id == "s1"
    assert entry.frontmatter.source_ref.channel_id == "wx1"


def test_migrate_record_handles_malformed_json_string():
    old = {
        "id": "mem-l-bad",
        "abstract": "x",
        "overview": "",
        "content": "y",
        "importance": 5,
        "entities_json": "not-json[",
        "tags": [],
        "source_json": "{broken",
        "read_count": 0,
        "version": 1,
        "created_at": "2026-01-01T10:00:00Z",
        "updated_at": "2026-01-01T10:00:00Z",
    }
    entry, warnings = migrate_record(old)
    # falls back to defaults; logs warnings; doesn't crash
    assert entry.frontmatter.type == "concept"
    assert entry.frontmatter.entities == []
    assert any("entities_json" in w for w in warnings)
    assert any("source_json" in w for w in warnings)


def test_migrate_record_lesson_uses_use_count():
    old = {
        "id": "mem-l-l1",
        "abstract": "经验：飞书发表情",
        "overview": "",
        "content": "用 emoji_id",
        "importance": 5,
        "entities": [],
        "tags": ["task_experience"],
        "source": {"type": "reflection"},
        "read_count": 7,
        "version": 1,
        "created_at": "2026-01-01T10:00:00Z",
        "updated_at": "2026-01-01T10:00:00Z",
    }
    entry, warnings = migrate_record(old)
    assert entry.frontmatter.type == "lesson"
    assert entry.frontmatter.maturity == "case"
    assert entry.frontmatter.lesson_meta is not None
    assert entry.frontmatter.lesson_meta.use_count == 7
