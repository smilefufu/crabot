"""Chain-of-Note: per-doc relevance label + reorder to avoid lost-in-middle."""
import json
import pytest
from src.long_term_v2.chain_of_note import (
    chain_of_note, NoteLabel, _reorder_for_lost_in_middle,
)


class FakeLLM:
    def __init__(self, payload):
        self.payload = payload

    async def chat_completion(self, messages, **kwargs):
        return json.dumps(self.payload)


@pytest.mark.asyncio
async def test_chain_of_note_assigns_labels_and_reorders():
    docs = [
        {"id": "m1", "brief": "张三的微信"},
        {"id": "m2", "brief": "饮食偏好"},
        {"id": "m3", "brief": "张三的电话"},
    ]
    payload = {
        "notes": [
            {"id": "m1", "label": "relevant", "rationale": "wechat"},
            {"id": "m2", "label": "irrelevant", "rationale": "off-topic"},
            {"id": "m3", "label": "relevant", "rationale": "phone"},
        ],
    }
    out = await chain_of_note("张三的联系方式", docs, llm=FakeLLM(payload))
    ids = [d["id"] for d in out]
    # relevant pushed to head and tail (avoid lost-in-middle)
    assert ids[0] == "m1"
    assert ids[-1] == "m3"
    # the irrelevant one is dropped
    assert "m2" not in ids


@pytest.mark.asyncio
async def test_chain_of_note_keeps_contextual_in_middle():
    docs = [
        {"id": "m1", "brief": "张三 wxid"},
        {"id": "m2", "brief": "张三所在部门"},
        {"id": "m3", "brief": "张三的电话"},
    ]
    payload = {
        "notes": [
            {"id": "m1", "label": "relevant", "rationale": ""},
            {"id": "m2", "label": "contextual", "rationale": ""},
            {"id": "m3", "label": "relevant", "rationale": ""},
        ],
    }
    out = await chain_of_note("张三的联系方式", docs, llm=FakeLLM(payload))
    ids = [d["id"] for d in out]
    assert ids[0] == "m1"
    assert ids[-1] == "m3"
    assert "m2" in ids[1:-1]


@pytest.mark.asyncio
async def test_chain_of_note_llm_failure_returns_input_order():
    class Boom:
        async def chat_completion(self, *a, **k):
            raise RuntimeError("api down")

    docs = [{"id": "m1", "brief": "x"}, {"id": "m2", "brief": "y"}]
    out = await chain_of_note("q", docs, llm=Boom())
    assert [d["id"] for d in out] == ["m1", "m2"]


def test_reorder_picks_endpoints_then_middle_for_relevant():
    notes = [
        ("a", NoteLabel.RELEVANT),
        ("b", NoteLabel.RELEVANT),
        ("c", NoteLabel.RELEVANT),
        ("d", NoteLabel.RELEVANT),
        ("e", NoteLabel.RELEVANT),
    ]
    out = _reorder_for_lost_in_middle(notes)
    assert out[0] == "a" and out[-1] == "b"
    assert set(out) == {"a", "b", "c", "d", "e"}


def test_reorder_mixed_relevant_and_contextual_locks_lost_in_middle_layout():
    """Spec §13.5 — 5-doc layout: head=relevant[0], tail=relevant[1],
    middle filled by remaining relevants then contextuals.
    Expected for [r1=R, r2=R, r3=R, r4=C, r5=C]: [r1, r3, r4, r5, r2].
    """
    notes = [
        ("r1", NoteLabel.RELEVANT),
        ("r2", NoteLabel.RELEVANT),
        ("r3", NoteLabel.RELEVANT),
        ("r4", NoteLabel.CONTEXTUAL),
        ("r5", NoteLabel.CONTEXTUAL),
    ]
    out = _reorder_for_lost_in_middle(notes)
    assert out == ["r1", "r3", "r4", "r5", "r2"], (
        f"lost-in-middle ordering changed: got {out}, expected [r1, r3, r4, r5, r2]"
    )


def test_reorder_no_relevant_returns_only_contextual():
    notes = [
        ("c1", NoteLabel.CONTEXTUAL),
        ("c2", NoteLabel.CONTEXTUAL),
    ]
    out = _reorder_for_lost_in_middle(notes)
    assert out == ["c1", "c2"]


def test_reorder_single_relevant_then_contextual():
    notes = [
        ("r1", NoteLabel.RELEVANT),
        ("c1", NoteLabel.CONTEXTUAL),
        ("c2", NoteLabel.CONTEXTUAL),
    ]
    out = _reorder_for_lost_in_middle(notes)
    assert out == ["r1", "c1", "c2"]
