"""Reciprocal Rank Fusion (RRF)."""
from typing import Dict, List, Set, Tuple


def rrf_fuse(
    paths: Dict[str, List[str]],
    k: int = 60,
    top: int = 50,
) -> List[Tuple[str, float, Set[str]]]:
    """Fuse multiple ranked id-lists with the RRF formula:

        score(d) = sum over paths p of  1 / (k + rank_p(d))

    Args:
      paths: {path_name: [mem_id ranked best-first]}
      k:     RRF constant, default 60 (Cormack et al.)
      top:   keep the top-N fused results

    Returns:
      [(mem_id, fused_score, contributing_paths), ...] sorted by score desc.
    """
    score: Dict[str, float] = {}
    contributors: Dict[str, Set[str]] = {}
    for path, ranked in paths.items():
        for rank, mem_id in enumerate(ranked):
            score[mem_id] = score.get(mem_id, 0.0) + 1.0 / (k + rank)
            contributors.setdefault(mem_id, set()).add(path)
    items = [(mid, s, contributors[mid]) for mid, s in score.items()]
    items.sort(key=lambda x: x[1], reverse=True)
    return items[:top]
