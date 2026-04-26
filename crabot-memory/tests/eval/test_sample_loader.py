"""Eval sample loader."""
import pytest
from pathlib import Path
from eval.sample_loader import EvalSample, load_suite


def test_load_suite_returns_list_of_samples(tmp_path):
    yaml_text = """
- id: ie-001
  category: IE
  setup_memories:
    - {type: fact, brief: 张三微信, content: wxid_zhangsan,
       entities: [{type: friend, id: z3, name: 张三}], tags: [], event_time: "2026-04-01T10:00:00Z"}
  query: 张三的微信号是多少
  ground_truth: wxid_zhangsan
  acceptable_answers: [wxid_zhangsan, "zhangsan 的 wxid 是 wxid_zhangsan"]
"""
    p = tmp_path / "IE.yaml"
    p.write_text(yaml_text, encoding="utf-8")

    samples = load_suite(str(p))
    assert len(samples) == 1
    s = samples[0]
    assert isinstance(s, EvalSample)
    assert s.id == "ie-001"
    assert s.category == "IE"
    assert s.query == "张三的微信号是多少"
    assert s.ground_truth == "wxid_zhangsan"
    assert "wxid_zhangsan" in s.acceptable_answers
    assert len(s.setup_memories) == 1


def test_load_suite_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_suite(str(tmp_path / "nope.yaml"))


def test_load_suite_validates_required_fields(tmp_path):
    p = tmp_path / "bad.yaml"
    p.write_text("- id: x\n", encoding="utf-8")
    with pytest.raises(ValueError, match="missing.*category"):
        load_suite(str(p))
