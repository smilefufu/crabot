"""LLM-as-judge categorical scoring."""
import json
import pytest
from eval.judge import judge_one, JudgeVerdict


class FakeLLM:
    def __init__(self, payload):
        self.payload = payload

    async def chat_completion(self, messages, **kwargs):
        return json.dumps(self.payload)


@pytest.mark.asyncio
async def test_judge_pass_when_ground_truth_substring_in_answer():
    out = await judge_one(
        query="张三的微信号", ground_truth="wxid_zhangsan",
        acceptable=["wxid_zhangsan"],
        candidate_answer="张三的微信是 wxid_zhangsan",
        llm=FakeLLM({"verdict": "pass", "rationale": "exact match"}),
    )
    assert out == JudgeVerdict.PASS


@pytest.mark.asyncio
async def test_judge_fail_for_completely_wrong_answer():
    out = await judge_one(
        query="张三的微信号", ground_truth="wxid_zhangsan",
        acceptable=["wxid_zhangsan"],
        candidate_answer="张三在上海",
        llm=FakeLLM({"verdict": "fail", "rationale": "off-topic"}),
    )
    assert out == JudgeVerdict.FAIL


@pytest.mark.asyncio
async def test_judge_partial_for_incomplete_answer():
    out = await judge_one(
        query="张三的城市和职业", ground_truth="北京 / 程序员",
        acceptable=["北京 程序员", "北京 程序员"],
        candidate_answer="张三在北京",
        llm=FakeLLM({"verdict": "partial", "rationale": "city only"}),
    )
    assert out == JudgeVerdict.PARTIAL


@pytest.mark.asyncio
async def test_judge_abstention_pass_when_candidate_says_unknown():
    out = await judge_one(
        query="王五的微信", ground_truth="不知道",
        acceptable=["我没有这个信息", "没有记录"],
        candidate_answer="抱歉我没有王五的微信信息",
        llm=FakeLLM({"verdict": "pass", "rationale": "abstain correctly"}),
    )
    assert out == JudgeVerdict.PASS


@pytest.mark.asyncio
async def test_judge_invalid_verdict_falls_back_to_fail():
    out = await judge_one(
        query="x", ground_truth="y",
        acceptable=[],
        candidate_answer="z",
        llm=FakeLLM({"verdict": "??", "rationale": ""}),
    )
    assert out == JudgeVerdict.FAIL


@pytest.mark.asyncio
async def test_judge_calls_llm_with_temperature_zero_for_reproducibility():
    """Spec §15 — judge must use temperature=0.0 so the same (query, gt, answer)
    yields a stable verdict across runs (categorical reproducibility).
    """
    captured: list = []

    class CaptureLLM:
        async def chat_completion(self, messages, **kwargs):
            captured.append({"messages": messages, "kwargs": kwargs})
            return json.dumps({"verdict": "pass", "rationale": ""})

    await judge_one(
        query="q", ground_truth="g",
        acceptable=["g"],
        candidate_answer="g",
        llm=CaptureLLM(),
    )
    assert len(captured) == 1
    assert captured[0]["kwargs"].get("temperature") == 0.0, (
        f"judge called with non-zero temperature, got {captured[0]['kwargs']}"
    )


@pytest.mark.asyncio
async def test_judge_same_input_yields_same_verdict_three_runs():
    """Determinism contract: with a deterministic FakeLLM (temperature=0.0 mock),
    invoking judge_one 3 times on identical inputs returns identical verdicts.
    """
    llm = FakeLLM({"verdict": "pass", "rationale": "match"})
    verdicts = []
    for _ in range(3):
        v = await judge_one(
            query="张三的微信",
            ground_truth="wxid_zhangsan",
            acceptable=["wxid_zhangsan"],
            candidate_answer="张三微信是 wxid_zhangsan",
            llm=llm,
        )
        verdicts.append(v)
    assert len(set(verdicts)) == 1, f"non-deterministic verdicts: {verdicts}"
    assert verdicts[0] == JudgeVerdict.PASS
