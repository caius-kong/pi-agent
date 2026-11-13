# auto-compact

上下文超过阈值时，由**模型**在合适的检查点决定压缩。扩展只负责"什么时候问"和"压缩后怎么继续"，**从不单方面强制压缩**：两条路径都是 LLM 动态谈判——只有模型调用 `request_compaction` 才会压缩，且每次都要再通过 boundary 的确定性安全复查。

## 为什么需要它

长任务跨多轮调度时上下文持续增长。Pi 自带的自动压缩要到 `contextWindow − 16384` 才触发，越晚压缩意味着越长时间的 context rot。本扩展提供一个更早、且**由模型判断**的触发点——而不是在 system prompt 里塞一段常驻指令（那样每轮都在干扰模型）。

第二个动机是价格：部分模型带 request-wide 定价层（如 `gpt-6.1-sol` 在 272k input tokens 后单价翻倍），因此这类模型的检查阈值会被压到 tier 边界之下（见"生效阈值"）。

## Features

| | mid-turn check | pre-turn check |
|---|---|---|
| hook | `context`（每轮） | `input`（收到用户输入时） |
| 做法 | 向本来就要发的请求尾部追加一条瞬态 user message | 扣住用户请求，另起一个完整 model run 做判断，settle 后再把请求发回 |
| 额外 LLM API 调用 | 无——提示**尾插**进本来就有的请求，增量 ≈ 提示自身 | **有**——每次判定一轮 `custom_message` run |

阈值以下两条路径都在 hook 里同步返回（`contextPercent` 返回 `undefined`）：不发请求、不追加消息，对对话延迟为零。会话首个请求没有可压缩历史，pre-turn 路径也直接放行。

两条路径共用同一个生效阈值（见下文"生效阈值"）、同一个 `request_compaction` 工具、同一套 boundary 安全复查与 continuation 机制。

## 基本原理与调用链

### mid-turn check

`turn_start` → `context` hook：若 usage 严格大于阈值，往**本次请求末尾**追加一条 transient 的 `[Pi auto-compact check]`（不落盘，模型只在被注入的那一轮看到，每轮至多一次）→ 模型判断 → 调 `request_compaction`（本轮唯一工具，`terminate: true`）→ `agent_before_settle` 安全复查 → 生成 compaction draft + continuation（`Context was compacted. Continue the task.`）→ Pi 提交 draft 并继续**同一个 run**。

- 判定标准（两处共用）：natural checkpoint —— 工作单元完成、无 pending（无运行中的工具 / 委派工作 / 排队消息 / 待用户决策）、goal/关键决策/约束/next action 可无损摘要、且整体任务仍有剩余工作。

### pre-turn check

`input` hook 命中条件（tui/rpc、agent 空闲、非流式 steer/follow-up、非 `/` 命令、usage 严格大于阈值、会话已有 assistant 轮次）→ 返回 `{ action: "handled" }` **暂存**该请求 → `pi.sendMessage(customType: "auto-compact-pre-turn", { triggerTurn: true })` 起判定 run（判定消息把请求原文作为**数据**给出，并明确不得在此执行它）→ 模型二选一：

- `request_compaction`（唯一工具）→ 同一套安全复查 → compaction draft + **continuation 的内容就是那条暂存请求** → 一次 run 内完成"压缩 → 开始新请求"，该请求只被服务一次。
- `SKIP-COMPACTION` → 判定 run 正常结束 → `agent_settled` 里 `sendUserMessage` 投递暂存请求。任何未被 compaction 消费的暂存请求都会在 settle 兜底投递（run 报错 / abort / 摘要失败都不丢消息）。
- 判定结果**不解析文本**，只看 `request_compaction` 是否入队；判定期间抑制 mid-turn 提示。
- 放行（不判定）：阈值以下、会话首个请求（没有可压缩历史）、`/` 命令、流式输入、非 tui/rpc 模式（print/json 里扩展起不了新 run，暂存会丢消息）。
- 为什么不把检查尾插到用户消息之后：用户请求尚未被服务时，模型以该请求为先，附在其后的元指令会被忽略（措辞强硬时还会被判为"用户消息中的嵌入式指令"而拒答）。把请求先扣下、判定才有立足点——同一段文本在 mid-turn（工具结果之后）有效、在 loop 之前无效。

### 安全边界压缩（两条路径共用）

`request_compaction` 的工具结果带 Pi 的 `terminate: true`。请求到达 `agent_before_settle` 后，扩展仅在本次 run 正常完成、没有其他 continuation、没有 queued message、没有待回复 supervisor 决策、没有 active subagent、且上下文仍高于阈值时才生成 compaction draft。摘要成功后返回 compaction draft + continuation，由 Pi 在 boundary handlers 全部完成后提交并继续同一 run；摘要失败或超过 120 秒则不提交 draft、报告错误，并提交一条"未压缩、继续任务"的 continuation 以免卡死。用户 abort、已有 continuation 或新消息时不强行续跑。

### 生效阈值（含 cost tier 覆盖）

两条路径判定的都是**生效阈值**，不是直接用手配阈值：

```
生效阈值 = min(配置阈值, (min(cost.tiers[].inputTokensAbove) − COST_TIER_SAFETY_TOKENS) / contextWindow × 100)
```

- 分母取 `ctx.getContextUsage().contextWindow`（与 `percent` 同源），tier 边界取 `ctx.model.cost.tiers`。
- 只有带 `cost.tiers` 的模型才可能被覆盖，且覆盖只能让检查**更早**。tier 边界落在窗口之外时（如 272k 窗口 + 272k 边界，Pi 计费要求 `inputTokens` 严格大于边界，而这个 SKU 的窗口就是边界），算出的百分比是 93.98%，高于配置阈值，`min` 之后仍是配置阈值。
- 减去 `COST_TIER_SAFETY_TOKENS`（16,384）是因为 tier 语义是"达到即翻倍"，而 `percent` 是估算值。
- 例：`trendmicro/gpt-6.1-sol`（窗口 1,050,000，tier 272,000）→ `(272000−16384)/1050000 = 24.34%`；`openai/gpt-6-sol`（窗口 272,000，tier 272,000）→ 仍是 40%。
- 覆盖只改"什么时候问"：提示措辞、模型协商、boundary 安全复查全部不变。因此它仍是 best-effort——模型在 24% 被问到时并不知道背后是价格悬崖。

## 成本与 prompt cache

| | 额外 API 调用 | prompt cache |
|---|---|---|
| mid-turn | 无（判定提示尾插在本来就要发的请求里） | 前缀（system + 历史）不变，只有尾部多出提示本身（100–300 tok，低于 Pi 的 `NOISE_FLOOR_TOKENS = 1024`）。⚠️ 若改成插到中间（如最后一条 toolResult 之前），其后全部内容每轮重算——不要这么做 |
| pre-turn | **有**：每次判定一轮 `custom_message` run | 判定 run 的请求前缀与"直接发这条请求"完全相同（system + 既有 transcript），只有尾部不同（custom message 而非 user message），所以前缀缓存仍可复用；判否后再投递原请求，前缀继续有效，只多出判定消息与那一轮回复 |
| 真正压缩之后 | 一次摘要请求 + 一条 continuation | compaction 重写上下文，缓存失效一次——这是压缩的固有成本 |

- pre-turn 的额外 token 代价：判定消息**引用了被暂存请求的原文**，这份副本随 transcript 进入后续每次请求（判否分支因此多一份请求文本）。
- 不做冷却/降频：判定本身就是"每来一条新输入重新判一次"，降频会压掉最需要重判的时刻（工作的中途换话题）。

## 已知边界（设计取舍，非缺陷）

- **在 natural checkpoint 请求压缩仍由模型判断**；扩展只有在 Pi 的 `agent_before_settle` 检查通过后才会写入压缩 draft，并验证本次 assistant turn 只请求了 `request_compaction`。阈值提醒是 best-effort，不代表一超过阈值就会立即压缩。
- pre-turn 判定 run 是一个普通 run：它能看到全部工具，也可能先跑无关命令再给出判定（实测出现过一次 `bash true` 后才回 `SKIP-COMPACTION`）；判定消息与该轮回复会留在 transcript，因此也会进入之后某次压缩的摘要（可审计性优先于摘要洁净度）。
- pre-turn 判定为"是"但压缩被拒（如会话太小）时，扩展**不**再发"未压缩、继续任务"的 continuation：暂存请求改由 `agent_settled` 投递，否则模型会先按"继续任务"把该请求做一遍、投递后又做一遍。
- Pi 按顺序执行所有 `agent_before_settle` handlers，待全部完成后才提交 drafts；本扩展复查后，后续 handler 仍可能改变排队消息或其他状态。当前 SDK 没有跨 handlers 的原子 barrier，因此不宣称系统级原子安全；若部署了其他 boundary handler，需结合现场状态验证兼容性。
- Pi 的原生 compaction 仍是 context limit 附近的 fallback。
- **无 token 增长冷却。**成功压缩后，下一轮若仍高于阈值且没有 pending request，transient hint 可以再次注入；是否在新的 natural checkpoint 再次压缩仍由模型判断，并重新经过 boundary、消息和 subagent 安全复查。未压缩时若后续 safe checkpoint 仍高于阈值，也允许重新评估；不要求先增长 token。每个 turn 最多注入一次，同轮重复执行 context hook 不会重复提醒。
- `/auto_compact` 可在当前 session 内覆盖配置阈值：`/auto_compact 40`、`/auto_compact 5` 或 `/auto_compact off`。范围为 0–100，严格大于阈值才触发；设置不写盘，仅当前 Pi extension/session 生命周期有效，生效阈值仍与 cost tier 覆盖取 min。无参数时同时显示配置值与生效值（如 `Auto-compact threshold: 50% (effective 24.3% — gpt-6.1-sol cost tier cap)`），无 tier 覆盖时只显示一个值。`off` 只关闭本扩展，不关闭 Pi 原生 compaction。
- 成功提交后：TUI 展示 compaction 与 continuation，JSON/RPC 输出 `entry_appended`（客户端需展示）；text/print 在 stderr 明确输出 `[auto-compact] Automatic compaction completed and is active in the session context.`，不污染 stdout 答案。仅准备 draft 不报告成功。
- 若 boundary 上已有 queued message 或其他 continuation，扩展不 compaction。Pi 会等 boundary handler 完成后检查 queued message；如果摘要生成期间有新消息或待回复 supervisor 决策到达，扩展丢弃 compaction draft，不覆盖新工作。Pi 也会在提交 boundary draft 后刷新上下文，并在执行 continuation 前再次检查队列。若请求因 pending/queued message 被拒绝，本次 run settle 后会清除此请求；后续 safe checkpoint 可再次请求。
- Main agent 若注册了 `subagent` 工具，会在摘要生成前后调用 `pi-subagents` v1 status RPC。只有回复可验证、fleet active count 为 0、且未截断的 status snapshot 显示所有 run 都已结束，才继续生成或提交 compaction draft；RPC 超时、格式不符、遗漏数不为 0 或仍有 active run 都 fail closed。Supervisor request 还会从当前 transcript 和 reply entries 检查。该 RPC snapshot 是时点读数，不是 coordinator lease；因此本扩展不对子 agent session 启用 compaction。
- `pi-subagents` 是可选集成，不 import 或加载该包。未注册 `subagent` 工具时，不访问 status RPC 或 event bus，正常执行 main-agent compaction；工具存在但服务缺失、抛错、状态未知时不压缩，任务仍按上述 continuation 规则继续，不将可选依赖问题升级为 agent failure。
- **Abort 语义（已接受的取舍）**：Pi 1.1.0 在 `agent_before_settle` 阶段可能不提供有效的 `ctx.signal`。用户在摘要期间 abort 后，已开始的摘要仍可能完成，Pi 会先提交 boundary drafts，再检查取消标志。这种已对 session context 生效的压缩可接受；Pi 不继续原任务，后续用户请求使用压缩后的 context。此处不修改 Pi runtime；可能仍消耗一次摘要请求的 tokens，等待受 120 秒 timeout 限制。成功通知只确认压缩已生效，不保证任务续跑。
- Boundary draft 不触发 native `session_before_compact` / `session_compact` hooks 或 native compaction progress events。依赖这些 hooks 的其他 extension 必须另行验证兼容性。

## config

### settings.json

全局 `~/.pi/agent/settings.json` 或项目级 `.pi/settings.json` 的 `auto_compact` 块：

```json
{ "auto_compact": { "compressionThresholdPercent": 40, "enableCostTiersOverrideThreshold": true } }
```

| 键 | 默认 | 说明 |
|---|---|---|
| `compressionThresholdPercent` | `40` | 检查阈值，0–100，严格大于才触发；非数字、越界值忽略并回落到 40 |
| `enableCostTiersOverrideThreshold` | `true` | 为 `true` 时，带 `cost.tiers` 的模型按 tier 边界提前检查（见"生效阈值"）；`false` 则只用配置阈值 |

扩展在**首个事件时读取一次**（加载期 runtime 未绑定，不能调 `pi.getSettings()`；无文件 watcher），改文件需重启 Pi。该块只读，扩展从不写入。

### 常量（`controller.mjs`）

| 常量 | 默认 | 说明 |
|---|---|---|
| `DEFAULT_THRESHOLD_PERCENT` | `40` | 未配置 `compressionThresholdPercent` 时的阈值 |
| `COST_TIER_SAFETY_TOKENS` | `16384` | tier 边界下保留的 token 余量 |
| `HINT_INTERVAL_TURNS` | `1` | 每 N 个 turn 至多提醒一次；默认每个 turn 检查。Pi 每个新 run 会重置 turn index，`agent_start` 同步重置提醒状态。|

## 实现

| 文件 | 作用 |
|---|---|
| `controller.mjs` | transient hint、压缩请求状态，以及 Pi `agent_before_settle` compaction draft 与 continuation |
| `index.ts` | 注册入口 |
| `../../../tests/auto-compact.test.mjs` | 单测：`node --test tests/auto-compact.test.mjs` |
| `../../evals/auto-compact-headless.mjs` | mid-run 路径的 headless print / JSON / RPC 真实模型端到端验收；临时阈值 5%，不改生产常量；用 `node evals/auto-compact-headless.mjs [--json|--rpc]` 运行 |
| `../../evals/auto-compact-pre-turn.mjs` | loop 开始前判定的真实模型验收（判否 / 判是 / 冻结基线对照），真实 1% 阈值 + 131k 窗口模型，不使用假百分比；头部记录 herdr 真实 agent 的验收步骤与结果；用 `node evals/auto-compact-pre-turn.mjs [--dry-run]` 运行 |

使用 **Pi 原语**：`pi.on("turn_start" | "context" | "agent_before_settle")`、`pi.registerTool()`、boundary compaction drafts、`ctx.getContextUsage()` 和 `ctx.modelRegistry.streamSimple()`。**无 Herdr 依赖**；context 检测与 compaction 不依赖 TUI UI。
