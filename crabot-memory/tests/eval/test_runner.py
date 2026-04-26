"""Eval runner end-to-end with all fakes."""
import json
import pytest
from eval.runner import run_suite, RunResult
from eval.sample_loader import EvalSample
from eval.judge import JudgeVerdict


class FakeAnswerer:
    """Stub an answerer that always returns the ground truth (pass case)."""

    def __init__(self, mode="echo_truth"):
        self.mode = mode

    async def answer(self, query: str, sample: EvalSample) -> str:
        if self.mode == "echo_truth":
            return sample.ground_truth
        if self.mode == "always_wrong":
            return "WRONG"
        return ""


class FakeJudge:
    def __init__(self, verdict: JudgeVerdict):
        self.verdict = verdict

    async def __call__(self, query, ground_truth, acceptable, candidate_answer, llm=None):
        return self.verdict


@pytest.mark.asyncio
async def test_run_suite_records_per_sample_verdicts():
    samples = [
        EvalSample(id="s1", category="IE", query="q1", ground_truth="g1"),
        EvalSample(id="s2", category="IE", query="q2", ground_truth="g2"),
    ]
    result = await run_suite(
        suite_name="IE", samples=samples,
        answerer=FakeAnswerer("echo_truth"),
        judge=FakeJudge(JudgeVerdict.PASS),
    )
    assert isinstance(result, RunResult)
    assert result.suite == "IE"
    assert len(result.per_sample) == 2
    assert all(v.verdict == JudgeVerdict.PASS for v in result.per_sample)


@pytest.mark.asyncio
async def test_run_suite_aggregates_pass_rate():
    samples = [
        EvalSample(id=f"s{i}", category="IE", query="q", ground_truth="g")
        for i in range(4)
    ]
    # Custom judge: pass for first 2, fail for last 2
    class PartialJudge:
        def __init__(self):
            self.calls = 0
        async def __call__(self, *a, **k):
            self.calls += 1
            return JudgeVerdict.PASS if self.calls <= 2 else JudgeVerdict.FAIL

    result = await run_suite(
        suite_name="IE", samples=samples,
        answerer=FakeAnswerer("echo_truth"),
        judge=PartialJudge(),
    )
    assert result.pass_count == 2
    assert result.fail_count == 2
    assert result.pass_rate == 0.5


@pytest.mark.asyncio
async def test_run_suite_handles_empty_samples():
    result = await run_suite(
        suite_name="IE", samples=[],
        answerer=FakeAnswerer(), judge=FakeJudge(JudgeVerdict.PASS),
    )
    assert result.per_sample == []
    assert result.pass_rate == 0.0
