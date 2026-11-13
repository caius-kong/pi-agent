# agent-goal

实时显示主代理当前目标（L2）+ 最后用户 prompt（L1）两行 widget。

## 为什么需要它

长任务中，用户需要知道 agent 当前在做什么、是否偏离轨道。Pi 本身没有内置的实时目标显示层，社区 `@narumitw/pi-goal` 是长任务自主执行系统（每轮注入 objective、自动推进、熔断），**不是显示层**。agent-goal 纯显示，不干预执行，可与之共存。

## 行为

1. **目标注入（contract）** — `before_agent_start` 每轮注入 ~680B CONTRACT，提醒长任务启动时调用 `set_goal` 工具自报目标。工具定义常驻工具清单。
2. **显示** — widget 两行灰字 `user_prompt` / `agent_goal` + footer 单行 `⛳`。零额外 LLM 调用、无 timer、纯事件驱动。
3. **持久化** — session entry（JSONL），随 session 走而非全局文件（与 pi-goal 相同模式）。
4. **切换 branch** — `session_tree` 时先清空本地状态再从**当前分支**重读；切到没有目标条目的 branch 就显示空，不沿用上一条 branch 的残留（`getEntries()` 含全部 branch，所以只扫 `getBranch()`）。

## 与 `@narumitw/pi-goal` 区别

| 维度 | agent-goal | @narumitw/pi-goal |
|---|---|---|
| 角色 | 纯显示层 | 长任务自主执行系统 |
| 目标来源 | LLM 自愿调用 `set_goal` | 每轮注入固定 objective |
| 熔断/控制 | 无 | 有（自动推进 + 熔断） |
| 冲突 | 不冲突，widget/status/tool key 均独立 | — |

## 成本

- 每轮固定 ~200–500 token（<1% 上下文窗），不随对话增长
- `set_goal` 每次调用 goal ≤120 char
- 零引入工具调用开销

## 配置

零配置。`/agent-goal on|off` 开关。

## 实现

| 文件 | 作用 |
|---|---|
| `index.ts` | 注册入口（~292 行），含状态机、widget 渲染、contract 注入 |
