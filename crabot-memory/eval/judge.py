"""LLM-as-judge: pass / partial / fail."""
import logging
from enum import Enum
from typing import List, Any

from src.utils.llm_client import extract_json

logger = logging.getLogger(__name__)


class JudgeVerdict(str, Enum):
    PASS = "pass"
    PARTIAL = "partial"
    FAIL = "fail"


_PROMPT = (
    "You are an evaluator for a memory-recall system.\n"
    "Given a query, the ground truth, a list of acceptable paraphrases, "
    "and the candidate's answer, return one of:\n"
    '- "pass": the candidate fully answers, paraphrases the ground truth, '
    "or correctly abstains when the ground truth is 不知道 / unknown.\n"
    '- "partial": the candidate gets part of the answer right but misses key info.\n'
    '- "fail": the candidate is wrong, irrelevant, or fabricates info.\n'
    'Return JSON: {"verdict": "pass|partial|fail", "rationale": "..."}'
)


async def judge_one(
    query: str, ground_truth: str, acceptable: List[str],
    candidate_answer: str, llm: Any,
) -> JudgeVerdict:
    user = (
        f"Query: {query}\n"
        f"Ground truth: {ground_truth}\n"
        f"Acceptable paraphrases: {acceptable}\n"
        f"Candidate answer: {candidate_answer}"
    )
    messages = [
        {"role": "system", "content": _PROMPT},
        {"role": "user", "content": user},
    ]
    try:
        resp = await llm.chat_completion(messages, temperature=0.0)
        data = extract_json(resp) or {}
        verdict = data.get("verdict", "fail")
        return JudgeVerdict(verdict)
    except (ValueError, Exception) as e:  # noqa: BLE001
        logger.warning("judge LLM failed or returned invalid verdict: %s", e)
        return JudgeVerdict.FAIL
