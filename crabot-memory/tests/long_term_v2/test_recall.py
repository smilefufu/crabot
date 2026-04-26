"""Recall basic merge + dedupe + sort."""
from src.long_term_v2.recall import merge_recall_results


def test_merge_dense_results_only():
    dense = [("mem-1", 0.9), ("mem-2", 0.8)]
    out = merge_recall_results(dense=dense, sparse=[], entity=[], tag=[], k=5)
    assert out == [
        ("mem-1", 0.9, "dense"),
        ("mem-2", 0.8, "dense"),
    ]


def test_merge_dedupes_keeping_max_score_and_first_source():
    dense = [("mem-1", 0.9)]
    sparse = [("mem-1", 0.7), ("mem-2", 0.6)]
    out = merge_recall_results(dense=dense, sparse=sparse, entity=[], tag=[], k=5)
    assert ("mem-1", 0.9, "dense") in out
    assert ("mem-2", 0.6, "sparse") in out
    assert len([r for r in out if r[0] == "mem-1"]) == 1


def test_merge_includes_entity_and_tag_with_default_score():
    out = merge_recall_results(
        dense=[],
        sparse=[],
        entity=["mem-3"],
        tag=["mem-4"],
        k=5,
    )
    ids = [r[0] for r in out]
    assert "mem-3" in ids
    assert "mem-4" in ids
    sources = {r[0]: r[2] for r in out}
    assert sources["mem-3"] == "entity"
    assert sources["mem-4"] == "tag"


def test_top_k_truncation():
    dense = [(f"mem-{i}", 1.0 - i * 0.01) for i in range(20)]
    out = merge_recall_results(dense=dense, sparse=[], entity=[], tag=[], k=5)
    assert len(out) == 5
    assert out[0][0] == "mem-0"
