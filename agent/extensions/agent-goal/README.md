# agent-goal

实时显示主代理当前目标（L2）+ 最后用户 prompt（L1）两行 widget。

## 为什么需要它

长任务中，用户需要知道 agent 当前在做什么、是否偏离轨道。Pi 本身没有内置的实时目标显示层，社区 `@narumitw/pi-goal` 是长任务自主执行系统（每轮注入 objective、自动推进、熔断），**不是显示层**。agent-goal 纯显示，不干预执行，可与之共存。

## 行为

1. **指令只有一处** — 全部写在 `set_goal` 工具的 `promptGuidelines` 里（外加一行 `promptSnippet` 和 `description`）。本扩展**不返回 `systemPrompt`、不设 `forceSystemPrompt`、不写 `sections[...]`**，所以不会顶掉其他扩展对结构化 prompt 的修改。
2. **显示** — widget 两行灰字 `user_prompt` / `agent_goal` + footer 单行 `⛳`。无 timer、无循环、无后台任务、无子代理，纯事件驱动。
3. **持久化** — session entry（`agent-goal-state`，JSONL），随 session 走而非全局文件（与 pi-goal 相同模式）。
4. **切换 branch** — `session_tree` 时先清空本地状态再从**当前分支**重读；切到没有目标条目的 branch 就显示空，不沿用上一条 branch 的残留（`getEntries()` 含全部 branch，所以只扫 `getBranch()`）。

## 可见性（OFF / headless）

`set_goal` 声明为 `exposure: "model-only"`，并由 `prepareLoadout` 在**扩展关闭（`/agent-goal off`）或会话没有 UI（`ctx.hasUI === false`，如 `pi -p`）**时隐藏自己的声明。

隐藏的实际含义：provider 收到的请求里**没有该工具的声明、没有 `promptSnippet`、也没有它的 `promptGuidelines`**；`codemode` 的 description 里也不会出现它（见下）。工具本身仍在 active 集合里，所以开关只改「是否声明」，不改 active 集合——`/agent-goal on` 不会把被外部 `--exclude-tools` / loadout 排除掉的 `set_goal` 加回来。

**可达性取舍**：`model-only` 的工具不能被其他工具经 `ctx.executeTool()` 调用。`codemode` 会把每个 callable 工具的 description 和 `promptGuidelines` 内联进自己的 description，因此可调用的 `set_goal` 即使隐藏了独立声明，仍会在 `codemode.mode="only"` 下把「如何维护目标」的规则泄漏给模型。`model-only` 消除这条泄漏；代价是其他工具（如 codemode 脚本）不能再间接调用 `set_goal`。对「主代理自报显示状态」这个用途没有损失。

**OFF 不清理历史**：`/agent-goal off` 停止声明与显示，已经写进 session JSONL 的 `agent-goal-state` 条目和 tool 调用记录都保留（不重写 transcript）。模型仍可能凭记忆发出一次 `set_goal` 调用；此时 `execute` 直接返回、不改状态、不写 entry、不刷新 widget。

## 成本

- **不主动调用模型**：扩展自身不发起任何模型请求。
- **prompt 侧固定占用**：启用且有 UI 时，实测（本仓库当前版本，渲染后的 system prompt 文本）新增 **1517 字符**——`<rules>` 中 5 条 guideline 渲染后共 1427 字符（含 `- ` 前缀）+ `<tools>` 中 `- set_goal: <snippet>` 一行 90 字符。token 数取决于模型 tokenizer，这里不给承诺值；按 4 字符/token 粗估约 320 token（仅估算）。关闭或无 UI 时为 0。
- **调度成本（预期内）**：`set_goal` 由模型按需调度，若它独占一次响应就会多一次模型往返。guideline 要求把它放进本轮第一个工具调用的同一响应、不要单独占一次响应，并禁止只为刷新显示多花往返。真实会话实测：`trendmicro/deepseek-v4.1-flash`（eval 默认）6 轮 0 次独占响应；`gpt-6.1-sol` 6 轮 6 次。两种都是可接受的调度成本。
- **依赖模型遵循 guideline**：同一个 6 轮真实会话里，`deepseek-v4-flash-0731` 只在起点和 pivot 各声明一次，新增约束与同 outcome 延续都不调用，目标行因此变陈旧。显示层不做补偿性推断；换用遵循度低的模型时，目标追踪会变差。

## 配置

零配置。`/agent-goal on|off`：停止或恢复工具声明与显示（不清理历史 transcript）。

## 与 `@narumitw/pi-goal` 区别

| 维度 | agent-goal | @narumitw/pi-goal |
|---|---|---|
| 角色 | 纯显示层 | 长任务自主执行系统 |
| 目标来源 | LLM 自愿调用 `set_goal` | 每轮注入固定 objective |
| 熔断/控制 | 无 | 有（自动推进 + 熔断） |
| 冲突 | 不冲突，widget/status/tool key 均独立 | — |

## 实现

| 文件 | 作用 |
|---|---|
| `index.ts` | 注册入口，含状态机、widget 渲染、`prepareLoadout` 可见性开关、`/agent-goal` 命令 |
| `../../tests/agent-goal-state.test.mjs` | 状态机单测（mock ExtensionAPI） |
| `../../tests/agent-goal-runtime.test.mjs` | 真实 `AgentSession` / `ExtensionRunner` 回归：不强制 system prompt、OFF/headless 可见性、同 run 内 OFF、其他工具不受影响、codemode `on`/`only` 不泄漏 |
| `../../evals/agent-goal/run-eval.cjs` | 真实模型端到端 eval：8 个脚本化场景，RPC 模式断言 widget/status + 状态层 + provider payload |
| `../../evals/agent-goal/run-acceptance.cjs` | 真实会话验收：**不裁剪工具集**的 agent 真实干活，6 个场景断言目标追踪（start/新增约束/子问题/纯步骤/pivot/同 outcome 延续）+ OFF |
