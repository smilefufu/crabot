"""Markdown I/O 测试。"""
import textwrap
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors,
)
from src.long_term_v2.markdown_io import dump_entry, load_entry


def _make_entry():
    return MemoryEntry(
        frontmatter=MemoryFrontmatter(
            id="mem-l-abc",
            type="fact",
            maturity="confirmed",
            brief="张三的微信",
            author="user",
            source_ref=SourceRef(type="manual"),
            source_trust=5,
            content_confidence=5,
            importance_factors=ImportanceFactors(
                proximity=0.5, surprisal=0.5,
                entity_priority=0.5, unambiguity=0.5,
            ),
            event_time="2026-04-23T10:00:00Z",
            ingestion_time="2026-04-23T10:01:00Z",
        ),
        body="张三的微信号是 wxid_test\n联系方式：手机 138-...",
    )


def test_dump_then_load_roundtrip():
    e = _make_entry()
    text = dump_entry(e)
    assert text.startswith("---\n")
    assert "\n---\n" in text
    e2 = load_entry(text)
    assert e2.frontmatter.id == "mem-l-abc"
    assert e2.body == "张三的微信号是 wxid_test\n联系方式：手机 138-..."


def test_dump_excludes_none_fields():
    e = _make_entry()
    text = dump_entry(e)
    assert "lesson_meta" not in text  # 默认 None
    assert "invalidated_by" not in text


def test_load_handles_extra_unknown_keys_gracefully():
    """旧文件可能含 v1 残留字段，应被忽略不报错。"""
    text = textwrap.dedent("""\
        ---
        id: mem-l-x
        type: fact
        maturity: observed
        brief: 测试
        author: user
        source_ref: { type: manual }
        source_trust: 3
        content_confidence: 3
        importance_factors: { proximity: 0.5, surprisal: 0.5, entity_priority: 0.5, unambiguity: 0.5 }
        event_time: 2026-04-23T10:00:00Z
        ingestion_time: 2026-04-23T10:00:00Z
        legacy_field: ignored
        ---
        body
    """)
    e = load_entry(text)
    assert e.frontmatter.id == "mem-l-x"


def test_load_rejects_missing_frontmatter_delimiter():
    import pytest
    with pytest.raises(ValueError, match="frontmatter"):
        load_entry("no fence here\nplain body")


def test_dump_preserves_unicode_brief():
    e = _make_entry()
    text = dump_entry(e)
    assert "张三的微信" in text  # 不应被转义为 \uXXXX
