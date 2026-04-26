"""Phase-1 basic recall merger."""
from typing import List, Tuple


def merge_recall_results(
    dense: List[Tuple[str, float]],
    sparse: List[Tuple[str, float]],
    entity: List[str],
    tag: List[str],
    k: int,
) -> List[Tuple[str, float, str]]:
    """合并 4 路结果，去重时保留最高 score 与最先到的 source。

    Args:
      dense: [(mem_id, cosine_score), ...]
      sparse: [(mem_id, bm25_score), ...]
      entity: [mem_id, ...] (无打分，统一 0.5)
      tag: [mem_id, ...] (无打分，统一 0.5)
      k: 最终返回前 k 条

    Returns:
      List of (mem_id, score, source).
    """
    seen = {}
    for mem_id, score in dense:
        seen[mem_id] = (score, "dense")
    for mem_id, score in sparse:
        if mem_id in seen:
            if score > seen[mem_id][0]:
                seen[mem_id] = (score, seen[mem_id][1])
        else:
            seen[mem_id] = (score, "sparse")
    for mem_id in entity:
        if mem_id not in seen:
            seen[mem_id] = (0.5, "entity")
    for mem_id in tag:
        if mem_id not in seen:
            seen[mem_id] = (0.5, "tag")

    items = [(mid, s, src) for mid, (s, src) in seen.items()]
    items.sort(key=lambda x: x[1], reverse=True)
    return items[:k]
