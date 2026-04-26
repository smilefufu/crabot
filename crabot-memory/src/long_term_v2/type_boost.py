"""Type-differentiated post-fusion boost.

- fact:    bi-temporal hit boosted; invalidated entries dropped.
- lesson:  use_count log-scaled boost; failed outcomes penalised.
- concept: passthrough.
"""
import math
from typing import Any, Dict, List


def apply_type_boost(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for c in candidates:
        type_ = c.get("type")
        score = float(c.get("score", 0.0))

        if type_ == "fact":
            if c.get("invalidated"):
                continue
            if c.get("in_time_window"):
                score += 0.2
        elif type_ == "lesson":
            use_count = int(c.get("use_count", 0))
            score += 0.1 * math.log1p(use_count)
            if c.get("outcome") == "failure":
                score -= 0.15
        # concept: passthrough

        out.append({**c, "score": score})

    out.sort(key=lambda x: x["score"], reverse=True)
    return out
