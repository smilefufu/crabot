# Memory v2 Eval Harness

5 categories × ≥30 samples. LLM-as-judge categorical scoring (pass/partial/fail).

## Setup

Set env vars before running:

- EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL
- LLM_API_KEY / LLM_BASE_URL / LLM_MODEL / LLM_FORMAT  (judge model — different from candidate model)

## Running

Run one suite against v2 (new pipeline):

    uv run python -m eval.cli --suite=IE --candidate=v2

Run all suites against legacy v1 (dense-only):

    uv run python -m eval.cli --suite=all --candidate=v1

Reports land in `eval/reports/report-<candidate>.md` and `.json`.

## Diff workflow

    uv run python -m eval.cli --suite=all --candidate=v1
    uv run python -m eval.cli --suite=all --candidate=v2
    diff eval/reports/report-v1.md eval/reports/report-v2.md

## Adding samples

Edit `eval/samples/<CAT>.yaml` following the template:

    - id: cat-NNN
      category: CAT
      setup_memories:
        - {type: fact, brief: ..., content: ..., entities: [], tags: [], event_time: "..."}
      query: ...
      ground_truth: ...
      acceptable_answers: [...]

Each suite must have ≥30 samples (enforced by Task 12 verifier).

## CI smoke

A loader-only smoke check (no LLM calls) is provided:

    bash scripts/run_eval_smoke.sh

This verifies all 5 suites have ≥30 samples each.
