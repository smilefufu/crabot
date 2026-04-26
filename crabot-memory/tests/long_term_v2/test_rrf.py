"""Reciprocal Rank Fusion."""
from src.long_term_v2.rrf import rrf_fuse


def test_rrf_single_path():
    out = rrf_fuse({"dense": ["a", "b", "c"]}, k=60, top=10)
    assert [m for m, _, _ in out] == ["a", "b", "c"]
    # rank 0 contributes 1/60, rank 1 -> 1/61
    assert out[0][1] > out[1][1] > out[2][1]


def test_rrf_two_paths_combine_ranks():
    out = rrf_fuse(
        {"dense": ["a", "b", "c"], "sparse": ["c", "a", "b"]},
        k=60, top=10,
    )
    ids = [m for m, _, _ in out]
    # 'a' is rank 0 + rank 1, 'c' is rank 2 + rank 0 → 'a' should win
    assert ids[0] == "a"
    assert set(ids[:3]) == {"a", "b", "c"}


def test_rrf_records_paths_per_id():
    out = rrf_fuse(
        {"dense": ["a"], "entity": ["a", "b"]},
        k=60, top=10,
    )
    paths_by_id = {m: paths for m, _, paths in out}
    assert paths_by_id["a"] == {"dense", "entity"}
    assert paths_by_id["b"] == {"entity"}


def test_rrf_top_truncation():
    out = rrf_fuse(
        {"dense": [f"m{i}" for i in range(10)]},
        k=60, top=3,
    )
    assert len(out) == 3


def test_rrf_empty_input_returns_empty():
    assert rrf_fuse({}, k=60, top=10) == []
    assert rrf_fuse({"dense": []}, k=60, top=10) == []
