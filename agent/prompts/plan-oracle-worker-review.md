---
description: 轻量级 plan-exec pipeline：oracle 审查方案是否满足原始需求/用户目标，确认后调度 worker 实施、reviewer 审查。方案确认后使用。
argument-hint: "[plan_or_custom_prompt]"
---

# Tasks:
1. 启动 oracle agent 审查当前方案：它是否覆盖原始需求/用户目标、有无遗漏或范围漂移、有无隐藏风险。只把方案、原始需求（PRD / issue / 我的目标描述）和相关路径交给它，要求给出明确 confirm/reject 结论与必须修正项。
2. reject → 按 oracle 的修正项改方案再送审，直到 confirm（最多 3 轮）；仍不 confirm 就停下来问我。
3. confirm → 调度 worker agent 按方案实施（单一写线程，最小改动）；完成后调度 reviewer agent 审查改动，HIGH 问题交回 worker 修复，循环直到 reviewer 无 HIGH 问题。
4. 报告：方案与原需求的对应关系、改动清单、reviewer 结论；确认无需求漂移后说明完成情况，等待我确认。

# Decision Escalation:
方案层面的分歧由 oracle 裁定，实现层面的分歧由 reviewer 裁定；仅在它们缺乏高置信度时才问我。

Additional instructions from the slash command invocation (custom prompt):

$@
