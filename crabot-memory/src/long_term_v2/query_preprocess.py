"""Step 0: query pre-process — coreference / time / HyDE / complexity."""
import logging
from dataclasses import dataclass
from typing import List, Optional, Tuple, Any

from src.long_term_v2.bi_temporal import parse_relative_window, utc_now
from src.utils.llm_client import extract_json

logger = logging.getLogger(__name__)


_PRONOUN_MARKERS = ("他", "她", "它", "他们", "她们", "它们", "this", "that", "they", "them")
_TIME_KEYWORDS = (
    "今天", "today", "昨天", "yesterday",
    "本周", "this week", "上周", "last week",
    "本月", "this month",
    "最近三天", "last 3 days", "最近一周", "last 7 days",
)


@dataclass
class ProcessedQuery:
    raw: str
    canonical: str
    complexity: str  # "simple" | "complex"
    time_window: Optional[Tuple[str, str]] = None
    hyde_doc: Optional[str] = None


def _needs_llm(query: str, recent_entities: Optional[List[dict]]) -> bool:
    if recent_entities and any(p in query for p in _PRONOUN_MARKERS):
        return True
    return len(query) > 40


def _detect_time_window(query: str) -> Optional[Tuple[str, str]]:
    for kw in _TIME_KEYWORDS:
        if kw in query.lower() or kw in query:
            window = parse_relative_window(kw, now=utc_now())
            if window:
                return window
    return None


_PROMPT = (
    "You preprocess a memory-search query.\n"
    "Given the user's raw query and a list of recently-mentioned entities, return JSON with keys:\n"
    "- canonical: the query with pronouns resolved to entity names. If unsure, repeat the raw query.\n"
    '- complexity: "simple" if a single fact lookup, "complex" if multi-hop / abstract.\n'
    "- needs_hyde: true if generating a hypothetical answer doc would help recall.\n"
    "- hyde_doc: 1-2 sentence hypothetical answer (only when needs_hyde=true).\n"
    "Output JSON only."
)


async def preprocess_query(
    query: str,
    recent_entities: Optional[List[dict]] = None,
    llm: Any = None,
) -> ProcessedQuery:
    canonical = query
    complexity = "simple"
    hyde_doc: Optional[str] = None
    time_window = _detect_time_window(query)

    if not _needs_llm(query, recent_entities) or llm is None:
        return ProcessedQuery(
            raw=query, canonical=canonical, complexity=complexity,
            time_window=time_window, hyde_doc=hyde_doc,
        )

    ent_text = ", ".join(f"{e['name']}({e['id']})" for e in (recent_entities or []))
    messages = [
        {"role": "system", "content": _PROMPT},
        {"role": "user", "content": f"Query: {query}\nRecent entities: {ent_text}"},
    ]
    try:
        resp = await llm.chat_completion(messages, temperature=0.0)
        data = extract_json(resp)
        if isinstance(data, dict):
            canonical = data.get("canonical") or query
            complexity = data.get("complexity") or "simple"
            if data.get("needs_hyde"):
                hyde_doc = data.get("hyde_doc")
    except Exception as e:  # noqa: BLE001
        logger.warning("query preprocess LLM call failed: %s — falling back to raw", e)

    return ProcessedQuery(
        raw=query, canonical=canonical, complexity=complexity,
        time_window=time_window, hyde_doc=hyde_doc,
    )
