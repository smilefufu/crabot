"""Report formatting for eval results."""
import json
from eval.report import render_markdown, render_json
from eval.runner import RunResult, SampleVerdict
from eval.judge import JudgeVerdict


def _sample_results():
    return [
        RunResult(
            suite="IE",
            per_sample=[
                SampleVerdict("ie-001", JudgeVerdict.PASS, "wxid_zhangsan"),
                SampleVerdict("ie-002", JudgeVerdict.FAIL, "WRONG"),
            ],
            pass_count=1, partial_count=0, fail_count=1,
        ),
        RunResult(
            suite="TR",
            per_sample=[
                SampleVerdict("tr-001", JudgeVerdict.PASS, "X"),
            ],
            pass_count=1, partial_count=0, fail_count=0,
        ),
    ]


def test_render_markdown_includes_per_suite_pass_rate():
    md = render_markdown(_sample_results(), label="v2-baseline")
    assert "v2-baseline" in md
    assert "| IE | 50.0% | 1 | 0 | 1 | 2 |" in md
    assert "| TR | 100.0% | 1 | 0 | 0 | 1 |" in md


def test_render_markdown_includes_overall_summary():
    md = render_markdown(_sample_results(), label="v2-baseline")
    # 2 pass + 0 partial + 1 fail of 3 total = 66.7%
    assert "Overall pass rate: **66.7%**" in md


def test_render_json_includes_all_per_sample():
    data = json.loads(render_json(_sample_results(), label="v2-baseline"))
    assert data["label"] == "v2-baseline"
    suite_names = {s["suite"] for s in data["suites"]}
    assert suite_names == {"IE", "TR"}
    ie = next(s for s in data["suites"] if s["suite"] == "IE")
    assert ie["pass_rate"] == 0.5
    assert len(ie["per_sample"]) == 2


def test_render_markdown_handles_empty_results():
    md = render_markdown([], label="empty")
    assert "Overall pass rate: **0.0%**" in md
