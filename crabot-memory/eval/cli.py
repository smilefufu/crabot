"""Eval CLI: run one or more suites against v1 / v2 answerers, write report."""
import argparse
import asyncio
import os
import sys
from pathlib import Path

from eval.sample_loader import load_suite
from eval.runner import run_suite
from eval.judge import judge_one
from eval.report import render_markdown, render_json
from eval.answerer import V2Answerer
from src.utils.llm_client import LLMClient

_SUITES = ("IE", "MR", "TR", "KU", "Abstention")


def _make_llm() -> LLMClient:
    return LLMClient(
        api_key=os.environ.get("LLM_API_KEY"),
        base_url=os.environ.get("LLM_BASE_URL"),
        model=os.environ.get("LLM_MODEL", "gpt-4o-mini"),
        format=os.environ.get("LLM_FORMAT", "openai"),
    )


async def _run(args) -> int:
    suites = _SUITES if args.suite == "all" else (args.suite,)
    llm = _make_llm()

    # v3: 只支持 V2 路径（V1 dense-only baseline 已删，因为 dense path 不再存在）
    answerer = V2Answerer(llm=llm)

    judge_callable = lambda **kw: judge_one(**kw)

    results = []
    for suite_name in suites:
        path = Path("eval/samples") / f"{suite_name}.yaml"
        if not path.exists():
            print(f"WARN: {path} not found, skipping", file=sys.stderr)
            continue
        samples = load_suite(str(path))
        r = await run_suite(
            suite_name=suite_name, samples=samples,
            answerer=answerer, judge=judge_callable, llm=llm,
        )
        results.append(r)

    label = f"{args.candidate}"
    md = render_markdown(results, label=label)
    js = render_json(results, label=label)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"report-{label}.md").write_text(md, encoding="utf-8")
    (out_dir / f"report-{label}.json").write_text(js, encoding="utf-8")
    print(md)
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--suite", default="all", choices=("all", *_SUITES))
    ap.add_argument("--candidate", default="v2", choices=("v2",))
    ap.add_argument("--out", default="eval/reports")
    args = ap.parse_args()
    sys.exit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
