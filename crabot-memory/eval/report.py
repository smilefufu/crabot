"""Render eval RunResult collections to markdown / json."""
import json
from typing import List

from eval.runner import RunResult


def _aggregate(results: List[RunResult]):
    total = sum(r.total for r in results)
    p = sum(r.pass_count for r in results)
    pa = sum(r.partial_count for r in results)
    f = sum(r.fail_count for r in results)
    rate = (p / total) if total else 0.0
    return total, p, pa, f, rate


def render_markdown(results: List[RunResult], label: str = "") -> str:
    total, p, pa, f, rate = _aggregate(results)
    lines = [f"# Eval Report: {label}", ""]
    lines.append("| Suite | Pass Rate | Pass | Partial | Fail | Total |")
    lines.append("|---|---|---|---|---|---|")
    for r in results:
        lines.append(
            f"| {r.suite} | {r.pass_rate * 100:.1f}% | {r.pass_count} | "
            f"{r.partial_count} | {r.fail_count} | {r.total} |"
        )
    lines.append("")
    lines.append(f"Overall pass rate: **{rate * 100:.1f}%** ({p}/{total}; partial={pa}, fail={f})")
    return "\n".join(lines)


def render_json(results: List[RunResult], label: str = "") -> str:
    total, p, pa, f, rate = _aggregate(results)
    return json.dumps({
        "label": label,
        "overall": {
            "pass_rate": rate, "pass": p, "partial": pa, "fail": f, "total": total,
        },
        "suites": [
            {
                "suite": r.suite,
                "pass_rate": r.pass_rate,
                "pass": r.pass_count,
                "partial": r.partial_count,
                "fail": r.fail_count,
                "total": r.total,
                "per_sample": [
                    {
                        "id": v.sample_id,
                        "verdict": v.verdict.value,
                        "candidate_answer": v.candidate_answer,
                    }
                    for v in r.per_sample
                ],
            }
            for r in results
        ],
    }, ensure_ascii=False, indent=2)
