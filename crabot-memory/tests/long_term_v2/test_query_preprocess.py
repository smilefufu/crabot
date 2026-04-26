"""Query pre-process: coreference / time / HyDE / complexity."""
import json
import pytest
from src.long_term_v2.query_preprocess import preprocess_query, ProcessedQuery


class FakeLLM:
    def __init__(self, response: str):
        self.response = response
        self.calls: list = []

    async def chat_completion(self, messages, **kwargs):
        self.calls.append(messages)
        return self.response


@pytest.mark.asyncio
async def test_simple_query_skips_llm():
    llm = FakeLLM(response="{}")
    out = await preprocess_query("张三的微信是多少", llm=llm)
    assert isinstance(out, ProcessedQuery)
    assert out.canonical == "张三的微信是多少"
    assert out.complexity == "simple"
    assert out.time_window is None
    assert out.hyde_doc is None
    assert llm.calls == []


@pytest.mark.asyncio
async def test_relative_time_parsed_locally_no_llm():
    llm = FakeLLM(response="{}")
    out = await preprocess_query("上周谈过的项目", llm=llm)
    assert out.time_window is not None
    start, end = out.time_window
    assert start < end
    assert llm.calls == []


@pytest.mark.asyncio
async def test_complex_query_invokes_llm_for_coref():
    llm = FakeLLM(response=json.dumps({
        "canonical": "张三和李四上次合作的项目进展",
        "complexity": "complex",
        "needs_hyde": True,
        "hyde_doc": "张三和李四曾在 X 项目合作，目前进展为 Y。",
    }))
    out = await preprocess_query(
        "他们上次合作的项目进展",
        recent_entities=[{"id": "z3", "name": "张三"}, {"id": "l4", "name": "李四"}],
        llm=llm,
    )
    assert out.canonical == "张三和李四上次合作的项目进展"
    assert out.complexity == "complex"
    assert out.hyde_doc.startswith("张三和李四")
    assert len(llm.calls) == 1


@pytest.mark.asyncio
async def test_llm_failure_falls_back_to_raw_query():
    class Boom:
        async def chat_completion(self, *a, **k):
            raise RuntimeError("api down")

    out = await preprocess_query(
        "他们上次合作的项目",
        recent_entities=[{"id": "z3", "name": "张三"}],
        llm=Boom(),
    )
    assert out.canonical == "他们上次合作的项目"
    assert out.complexity == "simple"
