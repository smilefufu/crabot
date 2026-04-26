#!/usr/bin/env bash
# Smoke check: load all eval suites and verify each has >=30 samples.
# Does NOT hit any LLM/embedding API. Safe to run in CI.
set -euo pipefail
cd "$(dirname "$0")/.."

.venv/bin/python -c "
from eval.sample_loader import load_suite
import sys
for cat in ('IE','MR','TR','KU','Abstention'):
    s = load_suite(f'eval/samples/{cat}.yaml')
    if len(s) < 30:
        print(f'FAIL: {cat} has {len(s)} samples (<30)', file=sys.stderr)
        sys.exit(1)
    print(f'OK: {cat} {len(s)} samples')
print('eval smoke passed')
"
