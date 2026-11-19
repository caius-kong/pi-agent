# agent-goal

在编辑器上方显示主代理理解的当前会话目标或剩余待办，以及最后一条真实用户消息。扩展只负责显示，不控制任务执行。

## 为什么需要它

长任务中，用户需要知道 agent 当前在做什么、是否偏离轨道。Pi 本身没有内置的实时目标显示层，社区 `@narumitw/pi-goal` 是长任务自主执行系统（每轮注入 objective、自动推进、熔断），**不是显示层**。agent-goal 纯显示，不干预执行，可与之共存。

## 行为

1. **自主更新** — `set_goal({ goal: string })` 接收一句摘要（最多 300 字符），替换整个目标行；空串清除。`description` 说明何时调用：目标首次明确或实质变化时，包括工作途中；普通追问和执行步骤不触发。`promptGuidelines` 说明如何摘要：合并新增要求，保留尚未完成的工作，移除已完成、取消或被替代的目标。扩展不推断目标、不强制调用，也不覆盖 system prompt。
2. **显示** — widget 两行灰字 `user_prompt` / `agent_goal`。footer 不写状态行：同一句目标若再占 footer，会挤掉其他扩展的开关（footer 状态只有一行、按 key 排序、超宽从尾部截断）。无 timer、无循环、无后台任务、无子代理，纯事件驱动。
3. **持久化** — session entry（`agent-goal-state`，JSONL），随 session 走而非全局文件（与 pi-goal 相同模式）。
4. **切换 branch** — `session_tree` 时先清空本地状态再从**当前分支**重读；切到没有目标条目的 branch 就显示空，不沿用上一条 branch 的残留（`getEntries()` 含全部 branch，所以只扫 `getBranch()`）。

## 可见性（OFF / headless）

`set_goal` 声明为 `exposure: "model-only"`，并由 `prepareLoadout` 在**扩展关闭（`/agent-goal off`）或会话没有 UI（`ctx.hasUI === false`，如 `pi -p`）**时隐藏自己的声明。

隐藏的实际含义：provider 收到的请求里**没有该工具的声明、没有 `promptSnippet`、也没有它的 `promptGuidelines`**；`codemode` 的 description 里也不会出现它（见下）。工具本身仍在 active 集合里，所以开关只改「是否声明」，不改 active 集合——`/agent-goal on` 不会把被外部 `--exclude-tools` / loadout 排除掉的 `set_goal` 加回来。

**可达性取舍**：`model-only` 的工具不能被其他工具经 `ctx.executeTool()` 调用。`codemode` 会把每个 callable 工具的 description 和 `promptGuidelines` 内联进自己的 description，因此可调用的 `set_goal` 即使隐藏了独立声明，仍会在 `codemode.mode="only"` 下把「如何维护目标」的规则泄漏给模型。`model-only` 消除这条泄漏；代价是其他工具（如 codemode 脚本）不能再间接调用 `set_goal`。对「主代理自报显示状态」这个用途没有损失。

**OFF 不清理历史**：`/agent-goal off` 停止声明与显示，已经写进 session JSONL 的 `agent-goal-state` 条目和 tool 调用记录都保留（不重写 transcript）。模型仍可能凭记忆发出一次 `set_goal` 调用；此时 `execute` 直接返回、不改状态、不写 entry、不刷新 widget。

## 成本

- **不主动调用模型**：扩展自身不发起任何模型请求。
- **固定输入**：启用且有 UI 时，工具声明（含参数 schema 和 provider 外壳）、snippet 和规则共 **735 字符**，按 chars/4 粗估约 **184 token**；带 `strict: false` 时约 188 token。关闭或无 UI 时不再发送这些固定文本。
- **调度成本**：模型自主调用。独占一次响应时会多一次模型往返；漏调时摘要可能陈旧，扩展不追加请求或推断目标。

## 配置

零配置。`/agent-goal on|off`：停止或恢复工具声明与显示（不清理历史 transcript）。

## 与 `@narumitw/pi-goal` 区别

| 维度 | agent-goal | @narumitw/pi-goal |
|---|---|---|
| 角色 | 纯显示层 | 长任务自主执行系统 |
| 目标来源 | LLM 自愿调用 `set_goal` | 每轮注入固定 objective |
| 熔断/控制 | 无 | 有（自动推进 + 熔断） |
| 冲突 | 不冲突，widget/tool key 均独立 | — |

## 实现

| 文件 | 作用 |
|---|---|
| `index.ts` | 单参数工具、摘要存储与 widget、`prepareLoadout` 可见性开关、`/agent-goal` 命令 |
| `../../tests/agent-goal-state.test.mjs` | 状态机单测（mock ExtensionAPI） |
| `../../tests/agent-goal-runtime.test.mjs` | 真实 `AgentSession` / `ExtensionRunner` 回归：不强制 system prompt、OFF/headless 可见性、同 run 内 OFF、其他工具不受影响、codemode `on`/`only` 不泄漏 |
| `../../evals/agent-goal/run-eval.cjs` | 真实模型端到端 eval：6 个脚本化场景，RPC 模式断言 widget + footer 无状态写入 + 状态层 + provider payload（tools / top-level `system` / `system` / `developer` 全扫） |
| `../../evals/agent-goal/lib/goal-evidence.cjs` | 两个 eval 共用的读取层：session 每轮快照、`set_goal` 调用、provider 错误、payload 指令面与 model/thinking 校验、唯一证据目录 |
| `../../tests/agent-goal-eval-harness.test.mjs` | 上述读取层的确定性 fixture：保留累计摘要、检查漏报与越界参数、developer 指令面可检出、invalid 与行为失败分离 |
| `../../tests/agent-goal-acceptance-script.test.mjs` | 用 `tests/fixtures/fake-pi` 驱动 `run-acceptance.cjs` 本身：跨轮状态、唯一证据目录、provider 报错判 invalid、不声明判行为失败 |
| `../../evals/agent-goal/run-acceptance.cjs` | 真实会话验收：**不裁剪工具集**的 agent 真实干活，检查首次目标、补充要求、并行待办、普通追问不刷新、同轮发现新待办后更新，以及 OFF 隔离；不要求固定标点或措辞 |

验收默认从当前 checkout 加载扩展。对照相同工具契约的指令候选时，可用 `node evals/agent-goal/run-acceptance.cjs --extension /path/to/candidate.ts --thinking high`，无需替换已安装版本。脚本启动时打印证据目录，`result.json` 随用户轮次更新；若被外部中止，`status: "running"` 表示证据未完成，不是验收结论。
