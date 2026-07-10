# Task 1 Report: Bash Legacy Result Contract

## Summary
- Updated legacy Bash tool result semantics so non-zero exits return `isError: false` and the tool output is structured with `exit_code`, `stdout`, and `stderr` fields.
- Kept timeout and abort behavior unchanged.
- Adjusted the focused Bash tool tests to assert the structured legacy contract.

## Files Changed
- `crabot-agent/src/engine/tools/bash-tool.ts`
- `crabot-agent/tests/engine/tools/bash-tool.test.ts`

## Verification
- Ran: `cd crabot-agent && ./node_modules/.bin/vitest run tests/engine/tools/bash-tool.test.ts`
- Result: `14 passed`

## Notes
- No additional files were modified.

## Fix Update
- Adjusted legacy `execFile` handling so only errors with a numeric exit code are treated as completed command results.
- Added a regression test for missing cwd / spawn-level failure to confirm the Bash tool still returns `isError: true`.

## Verification
- Ran: `cd crabot-agent && ./node_modules/.bin/vitest run tests/engine/tools/bash-tool.test.ts`
- Output summary: `1 passed`, `15 tests passed`; the new missing-cwd regression passed and the full Bash tool suite stayed green.
