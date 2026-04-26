"""Cross-encoder rerank client + fallback."""
import pytest
from src.long_term_v2.reranker import rerank, FallbackReranker


class FakeReranker:
    def __init__(self, scores):
        self.scores = scores
        self.called_with = None

    async def rerank_async(self, query, docs, top_n):
        self.called_with = (query, docs, top_n)
        ranked = sorted(zip(range(len(docs)), self.scores), key=lambda x: x[1], reverse=True)
        return [(i, s) for i, s in ranked[:top_n]]


@pytest.mark.asyncio
async def test_rerank_orders_by_score():
    rr = FakeReranker(scores=[0.1, 0.9, 0.5])
    docs = ["a", "b", "c"]
    out = await rerank("query", docs, top_n=3, client=rr)
    assert [d for d, _ in out] == ["b", "c", "a"]


@pytest.mark.asyncio
async def test_rerank_top_n_truncation():
    rr = FakeReranker(scores=[0.1, 0.9, 0.5, 0.7])
    docs = ["a", "b", "c", "d"]
    out = await rerank("q", docs, top_n=2, client=rr)
    assert len(out) == 2
    assert [d for d, _ in out] == ["b", "d"]


@pytest.mark.asyncio
async def test_rerank_empty_docs_returns_empty():
    rr = FakeReranker(scores=[])
    out = await rerank("q", [], top_n=5, client=rr)
    assert out == []


@pytest.mark.asyncio
async def test_rerank_client_failure_falls_back_to_passthrough():
    class Boom:
        async def rerank_async(self, query, docs, top_n):
            raise RuntimeError("rerank api down")

    docs = ["a", "b", "c"]
    out = await rerank("q", docs, top_n=2, client=Boom())
    assert [d for d, _ in out] == ["a", "b"]


@pytest.mark.asyncio
async def test_fallback_reranker_passes_through():
    fb = FallbackReranker()
    out = await fb.rerank_async("q", ["a", "b", "c"], top_n=2)
    # passthrough preserves input order, scores set to 1.0/(rank+1)
    assert [i for i, _ in out] == [0, 1]
