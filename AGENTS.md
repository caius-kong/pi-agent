# AGENTS.md

## 测试

- 全量：`node --test tests/*.test.mjs`（约 3 秒）。改任何扩展后跑它，别只跑一个文件。
- 单个扩展：`node --test tests/<扩展名>*.test.mjs`。
- 测试统一放 `tests/`，文件名 `*.test.mjs`；扩展目录里不放测试文件。
- `evals/` 只放需要真实模型或真实数据的评估（`agent-goal/run-eval.cjs`、`subagent.json`）；真实 gateway smoke 不等于阈值校准。
