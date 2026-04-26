"""Eval sample loader. Validates and loads YAML suites."""
from dataclasses import dataclass, field
from pathlib import Path
from typing import List
import yaml


@dataclass
class EvalSample:
    id: str
    category: str  # IE | MR | TR | KU | Abstention
    setup_memories: List[dict] = field(default_factory=list)
    query: str = ""
    ground_truth: str = ""
    acceptable_answers: List[str] = field(default_factory=list)


_REQUIRED = ("category", "query", "ground_truth")


def load_suite(path: str) -> List[EvalSample]:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(path)
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or []
    out: List[EvalSample] = []
    for i, item in enumerate(raw):
        for field_name in _REQUIRED:
            if field_name not in item:
                raise ValueError(f"sample {i} missing required field: {field_name}")
        out.append(EvalSample(
            id=item.get("id", f"unknown-{i}"),
            category=item["category"],
            setup_memories=item.get("setup_memories", []) or [],
            query=item["query"],
            ground_truth=item["ground_truth"],
            acceptable_answers=item.get("acceptable_answers", []) or [],
        ))
    return out
