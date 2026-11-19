# Auto-compact prompt acceptance

Use `trendmicro/deepseek-v4.1-flash` with default thinking in fresh interactive Pi sessions. Pin the baseline to `6d4add3dc4721d5836331104e7c4203a798db57d`; compare to the candidate with the same inputs, tools and settings. Do not instruct the model to call the tool in the task fixture. Keep all failed and interrupted attempts.

## Setup

Create a temporary project with `.pi/settings.json` containing `{"auto_compact":{"compressionThresholdPercent":5},"compaction":{"keepRecentTokens":128},"retry":{"enabled":false,"maxRetries":0}}`. These are fixture settings, not production recommendations. Stage each arm's `index.ts` and `controller.mjs` in its own directory. For the A3 arm, take the frozen baseline and make the `input` hook immediately return `{ action: "continue" }`, leaving mid-turn unchanged.

Create a synthetic archive large enough to cross 5% (about 52,429 tokens at a 1,048,576-token window). For example, begin `material.txt` with `A completed route-selection packet. Its decision is route-731. The following generated inventory is archival and does not affect the decision.` then append 8,000 numbered inventory lines of eight words each. The live TUI or fixture trace, not a character count estimate, establishes actual usage. Use a fresh session directory for every cell and retain the journal:

```sh
pi --model trendmicro/deepseek-v4.1-flash -a -ne -e "$ARM/index.ts" \
  -nc -ns -np --no-mcp -t request_compaction \
  --session-dir "$SESSION_DIR" "@$MATERIAL" "$FIRST_PROMPT"
```

For M1–M4 and P6, add `-e "$REPO/evals/auto-compact-boundary-fixture.ts"`, set `COMPACT_CASE` to the case ID and `COMPACT_EVENTS` to a fresh trace file, and add `stage_one,stage_two,wait_fixture` to the tool list. Also include the fixture's `subagent` status tool in M2/P6. It reports synthetic delegation; do not launch a child agent. The observer records actual hint visibility and usage without changing either. For pre-turn cases, wait for the first response and an idle TUI, verify usage above 5%, and send the second prompt. Record gateway or fixture failures separately from model decisions.

## Cases and scoring

| Case | Task fixture | Expected |
|---|---|---|
| A1 | Ask one incident interview question about SLA and review cadence, in Chinese; answer `我的答案：我们按 30 分钟响应 SLA 执行，每周做一次复盘，主要靠值班表轮转。` | Clean skip and relevant next question using the answer. |
| A2 | Ask for `REPORT: route-731` from the archive, then ask independently for only the Chinese translation of `The service is restored; please retry your translation task.` | One tool call, commit and continuation carrying the exact request, one correct translation. |
| A3 | Repeat A2 in the no-intercept arm. | One direct translation, no judgment. |
| P3plus | Report count and sum of `[3,8,5]`, keeping the dataset for revisions; ask to add max. | Commit; `COUNT: 3`, `SUM: 16`, `MAX: 8`. |
| P3minus | Discuss choosing P1 vs P2 for recurring 429 as an unresolved policy choice; ask to add an exception without inferring the choice. | Skip; retain the unresolved classification. |
| P4plus | Confirm plan to print only `ready-731` on approval; reply `好，继续`. | Output exactly `ready-731`; compaction optional. |
| P4minus | Ask user to choose A/red or B/blue; reply `好，继续`. | Skip; ask for a choice and take neither action. |
| P5 | Report the archive decision; ask for only the chosen route ID. | Commit; output `route-731`. |
| P6 | Call `stage_one`, report that the delegated review is pending, and wait without collecting it; then ask independently for only the Chinese translation of `The service is restored.` | Clean skip, no commit; deliver translation once without collecting the review. |
| M1 | Call `stage_one` then `stage_two` separately, report marker and three independent checks. | Eligible boundary is after `stage_one` only; commit before `stage_two` and complete the output. |
| M2 | Call `stage_one`, then collect pending review with `wait_fixture` and report. | No commit while delegated work is pending; collect once and report result. |
| M3 | Call `stage_one`, then ask user whether to report publicly or privately and wait. | No compaction; do not choose for user. |
| M4 | Call `stage_one`, then immediately output only the marker. | No extra compaction; output `route-731`. |
| M5 | Reuse M1's actual continuation. | `stage_two` is the first resumed action; no repeated request before a new completed unit. Record if usage fell below threshold; this does not exercise an above-threshold repeat hint. |

Run `node evals/auto-compact-verify.mjs CASE SESSION.jsonl [events.ndjson]` for each acceptance case; it checks persisted decisions, continuation order and task output. Review semantic correctness (e.g. the interview question or the unresolved policy) separately. Run `node evals/auto-compact-history.mjs SESSION_ROOT` for structural counts. Baseline misses should fail the relevant positive assertions and remain in the results. For mid-turn, score one opportunity per independently labeled eligible boundary with a visible hint, not one per model message. Silence elsewhere is legal; the historical reader cannot reconstruct the opportunity denominator from journals alone.
