"""Eval runner: pipe samples through answerer + judge, aggregate verdicts."""
from dataclasses import dataclass, field
from typing import Any, List

from eval.sample_loader import EvalSample
from eval.judge import JudgeVerdict


@dataclass
class SampleVerdict:
    sample_id: str
    verdict: JudgeVerdict
    candidate_answer: str


@dataclass
class RunResult:
    suite: str
    per_sample: List[SampleVerdict] = field(default_factory=list)
    pass_count: int = 0
    partial_count: int = 0
    fail_count: int = 0

    @property
    def total(self) -> int:
        return len(self.per_sample)

    @property
    def pass_rate(self) -> float:
        if self.total == 0:
            return 0.0
        return self.pass_count / self.total


async def run_suite(
    suite_name: str,
    samples: List[EvalSample],
    answerer: Any,
    judge: Any,
    llm: Any = None,
) -> RunResult:
    result = RunResult(suite=suite_name)
    for s in samples:
        candidate = await answerer.answer(s.query, s)
        verdict = await judge(
            query=s.query,
            ground_truth=s.ground_truth,
            acceptable=s.acceptable_answers,
            candidate_answer=candidate,
            llm=llm,
        )
        result.per_sample.append(SampleVerdict(
            sample_id=s.id, verdict=verdict, candidate_answer=candidate,
        ))
        if verdict == JudgeVerdict.PASS:
            result.pass_count += 1
        elif verdict == JudgeVerdict.PARTIAL:
            result.partial_count += 1
        else:
            result.fail_count += 1
    return result
