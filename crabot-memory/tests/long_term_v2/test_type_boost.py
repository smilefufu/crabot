"""Type-differentiated boost over fused candidates."""
from src.long_term_v2.type_boost import apply_type_boost


def _candidate(mem_id, type_, base_score, **meta):
    return {"id": mem_id, "type": type_, "score": base_score, **meta}


def test_fact_boosted_when_in_time_window():
    candidates = [
        _candidate("m1", "fact", 0.5, in_time_window=True),
        _candidate("m2", "fact", 0.5, in_time_window=False),
    ]
    out = apply_type_boost(candidates)
    by_id = {c["id"]: c for c in out}
    assert by_id["m1"]["score"] > by_id["m2"]["score"]


def test_lesson_boosted_by_use_count_and_success():
    candidates = [
        _candidate("a", "lesson", 0.5, use_count=10, outcome="success"),
        _candidate("b", "lesson", 0.5, use_count=0, outcome="success"),
        _candidate("c", "lesson", 0.5, use_count=10, outcome="failure"),
    ]
    out = apply_type_boost(candidates)
    scores = {c["id"]: c["score"] for c in out}
    assert scores["a"] > scores["b"]
    assert scores["a"] > scores["c"]


def test_concept_score_unchanged():
    candidates = [_candidate("m1", "concept", 0.5)]
    out = apply_type_boost(candidates)
    assert out[0]["score"] == 0.5


def test_invalidated_fact_excluded():
    candidates = [
        _candidate("m1", "fact", 0.9, invalidated=True),
        _candidate("m2", "fact", 0.4, invalidated=False),
    ]
    out = apply_type_boost(candidates)
    assert {c["id"] for c in out} == {"m2"}


def test_results_resorted_by_boosted_score():
    candidates = [
        _candidate("a", "lesson", 0.4, use_count=20, outcome="success"),
        _candidate("b", "lesson", 0.6, use_count=0, outcome="success"),
    ]
    out = apply_type_boost(candidates)
    assert out[0]["id"] == "a"
