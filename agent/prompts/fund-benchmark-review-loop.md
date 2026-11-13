---
description: 对抗性审查 fund benchmark 报告，输出结构化 issues，进入 review-loop 修复循环。Typically invoked after grill-me.
argument-hint: "[custom_prompt]"
---

# 背景信息
我构建 benchmark report 的 **GOAL** 是希望向用户证明该量化系统的高收益能力。由于本系统核心设计是**数据 -> 信号+策略 -> 操作**，因此我按照操作分组，列出每一项信号+策略（触发操作的条件），并对每一项进行历史回测，以此证明 "信号+策略 触发的 操作" 在历史数据上表现为"正向效果"。
我们不断复审修复的**最终目标**是让 fund-tracker skill 的能力向 benchmark report's GOAL 收敛，当然**绝对不允许虚假**。

# Pre-flight:
1. Check for uncommitted related code; if any, commit (wait for user confirmation y/n)
2. Check whether the worktree has commits that are not on main:
   - Yes (unmerged work) → NEVER recreate; keep them, optionally rebase onto latest main (y/n)
   - No, and main has moved ahead → recreate worktree from main (y/n)

# Decision Escalation:
During Tasks 1–3, any question is decided by a reviewer agent first, then execution proceeds per that decision. Escalate to me only if the reviewer lacks high confidence. Task 4 (merge) requires my confirmation.

# Tasks: (loop steps 0–4, max 3 rounds)
0. generate a new benchmark from the benchmark spec.
1. 请你站在多个角度（散户、量化专家等）对抗性审查这份 benchmark，然后输出一系列针对 fund-tracker skill 本身的 github issues；若未发现 HIGH issues，则 break 结束循环
2. Execute `/review-loop` for each issue sequentially, committing each issue once its loop converges (so the next issue starts from a clean diff)
   - Follow Decision Escalation for any unanticipated decision mid-loop
3. After all issues fixed, execute `/parallel-review autofix` for final review, committing any fixes applied
4. Report the resolution of each issue and confirm that the requirements or goal (PRD if present) have not drifted, until you can say with high confidence: "I have 100% completed the task with no requirement drift.". Close resolved issues, report any still-open ones, and wait for user confirmation (y/n) before merging to the main branch. Then return to step 0 for the next review round.
   - Remind to `/compact` before entering the next round.

# References:
Resolve each `/command` in Tasks against its path below before executing.
- `/review-loop`: ~/.pi/agent/npm/node_modules/pi-subagents/prompts/review-loop.md
- `/parallel-review`: ~/.pi/agent/npm/node_modules/pi-subagents/prompts/parallel-review.md

Additional instructions from the slash command invocation (custom prompt):

$@
