"""Frontmatter markdown I/O."""
import datetime as _dt
import yaml
from src.long_term_v2.schema import MemoryEntry, MemoryFrontmatter


_FENCE = "---"


def _stringify_datetimes(obj):
    """YAML 会把 ISO8601 字符串解析成 datetime；这里还原为字符串以匹配 schema。"""
    if isinstance(obj, dict):
        return {k: _stringify_datetimes(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_stringify_datetimes(v) for v in obj]
    if isinstance(obj, _dt.datetime):
        s = obj.isoformat()
        if obj.tzinfo is not None and s.endswith("+00:00"):
            s = s[:-6] + "Z"
        return s
    if isinstance(obj, _dt.date):
        return obj.isoformat()
    return obj


def dump_entry(entry: MemoryEntry) -> str:
    fm_dict = entry.frontmatter.model_dump(exclude_none=True, mode="json")
    yaml_text = yaml.safe_dump(fm_dict, sort_keys=False, allow_unicode=True).rstrip()
    return f"{_FENCE}\n{yaml_text}\n{_FENCE}\n{entry.body}"


def load_entry(text: str) -> MemoryEntry:
    if not text.startswith(_FENCE + "\n"):
        raise ValueError("missing opening frontmatter fence")
    rest = text[len(_FENCE) + 1:]
    end_idx = rest.find(f"\n{_FENCE}\n")
    if end_idx < 0:
        raise ValueError("missing closing frontmatter fence")
    yaml_text = rest[:end_idx]
    body = rest[end_idx + len(_FENCE) + 2:]
    raw = yaml.safe_load(yaml_text) or {}
    raw = _stringify_datetimes(raw)
    fm = MemoryFrontmatter.model_validate(raw)
    return MemoryEntry(frontmatter=fm, body=body)
