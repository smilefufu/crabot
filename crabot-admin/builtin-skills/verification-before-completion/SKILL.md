<!--
Source: superpowers v5.0.7 (MIT License) — https://github.com/obra/superpowers/blob/v5.0.7/skills/verification-before-completion/SKILL.md
Snapshot date: 2026-05-18
本文件由 Crabot 内置以提供 code_writer subagent 的"完成前自检"指南。
基于上述上游版本，按 Crabot 的任务职责和验证原则适配。
-->

---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires verification evidence that applies to the current changes and the scope of the claim; evidence before assertions always
---

# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT VALID VERIFICATION EVIDENCE
```

Before claiming a result, confirm that verification evidence covers the current changes and the scope of the claim. Reuse earlier command output when relevant code, dependencies, configuration, and environment are unchanged and no new evidence calls the result into question.

Run verification again when relevant inputs changed, the evidence is incomplete, or a new failure needs investigation. A new message or task handoff alone does not invalidate existing evidence.

Choose verification scope to match the change and the claim. A targeted check supports a targeted conclusion; it does not establish that the entire project passes.

## The Gate Function

```
BEFORE claiming success, completion, or correctness:

1. IDENTIFY: What command proves this claim?
2. OBTAIN: Reuse applicable output, or run the required checks if evidence is missing, stale, or incomplete
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Output for the claimed test scope: 0 failures | Stale output, incomplete evidence, "should pass" |
| Linter clean | Linter output for the claimed scope: 0 errors | Extrapolating beyond checked files |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Claiming more than the verification covers
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without applicable verification evidence**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "I'm confident" | Confidence ≠ evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter ≠ compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion ≠ excuse |
| "A targeted check proves everything" | Match the claim to the verified scope |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Tests:**
```
✅ [Run test command] [See: 34/34 pass] "All tests pass"
❌ "Should pass now" / "Looks correct"
```

**Regression tests (TDD Red-Green):**
```
✅ Write → Run (pass) → Revert fix → Run (MUST FAIL) → Restore → Run (pass)
❌ "I've written a regression test" (without red-green verification)
```

**Build:**
```
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
```

**Requirements:**
```
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
```

**Agent delegation:**
```
✅ Agent reports success → Check VCS diff → Verify changes → Report actual state
❌ Trust agent report
```

## Why This Matters

From 24 failure memories:
- your human partner said "I don't believe you" - trust broken
- Undefined functions shipped - would crash
- Missing requirements shipped - incomplete features
- Time wasted on false completion → redirect → rework
- Violates: "Honesty is a core value. If you lie, you'll be replaced."

## When To Apply

**ALWAYS when claiming success, completion, or correctness**, including commits, PRs, task completion, and task handoffs. Check that the evidence is still applicable; these events do not by themselves require another test run.

**Rule applies to:**
- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness

## The Bottom Line

**No shortcuts for verification.**

Confirm applicable evidence. Read the output. THEN claim the result.

This is non-negotiable.
