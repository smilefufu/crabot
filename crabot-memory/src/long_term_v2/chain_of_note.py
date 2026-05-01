"""Step 4: Chain-of-Note — LLM labels each doc and we reorder to avoid Lost-in-Middle."""
import logging
import time
from enum import Enum
from typing import Any, Dict, List, Tuple

from src.utils.llm_client import extract_json

logger = logging.getLogger(__name__)


class NoteLabel(str, Enum):
    RELEVANT = "relevant"
    CONTEXTUAL = "contextual"
    IRRELEVANT = "irrelevant"


_PROMPT = (
    "You read a query and a list of memory snippets. For each snippet, output one of:\n"
    '- "relevant": directly answers the query\n'
    '- "contextual": background that may help, not direct answer\n'
    '- "irrelevant": unrelated, drop it\n'
    "Return JSON: {notes: [{id, label, rationale}, ...]} preserving the input order."
)


def _reorder_for_lost_in_middle(notes: List[Tuple[str, NoteLabel]]) -> List[str]:
    """Place relevant items at the head and tail; contextual filling the middle."""
    relevant = [mid for mid, lbl in notes if lbl == NoteLabel.RELEVANT]
    contextual = [mid for mid, lbl in notes if lbl == NoteLabel.CONTEXTUAL]
    if not relevant:
        return contextual
    if len(relevant) == 1:
        return [relevant[0]] + contextual
    head = [relevant[0]]
    tail = [relevant[1]]
    middle_relevant = relevant[2:]
    return head + middle_relevant + contextual + tail


async def chain_of_note(
    query: str, docs: List[Dict[str, Any]], llm: Any,
) -> List[Dict[str, Any]]:
    """Annotate then reorder. Each doc must have at least 'id' and 'brief'."""
    if not docs:
        return []
    listing = "\n".join(f"- id={d['id']}: {d.get('brief', '')}" for d in docs)
    messages = [
        {"role": "system", "content": _PROMPT},
        {"role": "user", "content": f"Query: {query}\nSnippets:\n{listing}"},
    ]
    prompt_chars = sum(len(m["content"]) for m in messages)
    t_llm = time.perf_counter()
    resp = ""
    try:
        resp = await llm.chat_completion(messages, temperature=0.0)
        elapsed_ms = (time.perf_counter() - t_llm) * 1000
        logger.info(
            "chain_of_note llm_call: docs=%d prompt_chars=%d resp_chars=%d latency_ms=%.0f",
            len(docs), prompt_chars, len(resp or ""), elapsed_ms,
        )
        data = extract_json(resp)
        notes = (data or {}).get("notes") or []
    except Exception as e:  # noqa: BLE001
        elapsed_ms = (time.perf_counter() - t_llm) * 1000
        logger.warning(
            "chain-of-note LLM failed after %.0fms (%s) — keeping input order", elapsed_ms, e,
        )
        return docs

    label_by_id: Dict[str, NoteLabel] = {}
    for n in notes:
        try:
            label_by_id[n["id"]] = NoteLabel(n["label"])
        except (KeyError, ValueError):
            continue

    paired: List[Tuple[str, NoteLabel]] = []
    for d in docs:
        lbl = label_by_id.get(d["id"], NoteLabel.CONTEXTUAL)
        if lbl == NoteLabel.IRRELEVANT:
            continue
        paired.append((d["id"], lbl))

    ordered_ids = _reorder_for_lost_in_middle(paired)
    by_id = {d["id"]: d for d in docs}
    return [by_id[i] for i in ordered_ids if i in by_id]
