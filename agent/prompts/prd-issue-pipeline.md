---
description: PRD → spec → GitHub issues → per-issue review-loop → final parallel-review, with merge gate. Typically invoked after grill-me.
argument-hint: "[custom_prompt]"
---

# Pre-flight:
1. Check for uncommitted related code; if any, commit (wait for user confirmation y/n)
2. Check whether the worktree has commits that are not on main:
   - Yes (unmerged work) → NEVER recreate; keep them, optionally rebase onto latest main (y/n)
   - No, and main has moved ahead → recreate worktree from main (y/n)

# Decision Escalation:
During Tasks 1-3, have a reviewer agent decide any question on my behalf first, then continue per its decision (including to-tickets' breakdown quiz — iterate via reviewer until high confidence). Ask me only if it lacks high confidence. Task 4 still requires my merge confirmation.

# Tasks:
1. Execute `/to-spec` → `/to-tickets` to generate github issues
2. Execute `/review-loop` for each issue sequentially, committing each issue once its loop converges (so the next issue starts from a clean diff)
   - Follow Decision Escalation for any unanticipated decision mid-loop
3. After all issues fixed, execute `/parallel-review autofix` for final review, committing any fixes applied
4. Report the resolution of each issue and confirm that the requirements or goal (PRD if present) have not drifted, until you can say with high confidence: "I have 100% completed the task with no requirement drift.". Close resolved issues, report any still-open ones, and wait for user confirmation (y/n) before merging to the main branch.

# References:
Resolve each `/command` in Tasks against its path below before executing.
- `/to-spec`: ~/.agents/skills/to-spec/SKILL.md
- `/to-tickets`: ~/.agents/skills/to-tickets/SKILL.md
- `/review-loop`: ~/.pi/agent/npm/node_modules/pi-subagents/prompts/review-loop.md
- `/parallel-review`: ~/.pi/agent/npm/node_modules/pi-subagents/prompts/parallel-review.md

Additional instructions from the slash command invocation (custom prompt):

$@
