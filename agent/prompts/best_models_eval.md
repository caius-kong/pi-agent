---
description: 评估 subagents 的最佳 agent × model × thinking 组合（业界基准 / 基础能力指标 / 真实实测 / gateway 成本 → 角色推荐），不改配置，只询问是否同步到 paid profile
---

评估 `~/.pi/agent/profiles/pi-subagents/paid.json` 当前组合是否仍是最佳，并给出每个 subagent 角色的推荐 `model × 实际生效 thinking 档`。

**本模板只产出评估结论，不修改 `paid.json` / `settings.json`。** 需要落地时，按「交付」一节只问两个 y/n。

## 判定规则（违反任一条，结论作废）

1. **成本口径**：以**官方牌价（峰价）**为准做取舍，公司 gateway 实收（`x-litellm-key-spend`）作为补充解释；两口径背离 **>1.5×** 时必须两列并示，并说明折扣可能失效。质量优势可以覆盖成本差，但必须在推荐表里写清「多花多少」。
2. **业内基准必须带档位**：每个候选 × 每个候选 thinking 档都要有 AA 等第三方记录，写 `@thinking` + 来源 URL + benchmark harness 名称与版本。**AA 只公布 `max` 档时不得外推 `low`/`high`**；跨 harness（Terminal-Bench / DeepSWE / Apex …）只并列不排序；缺失写 `n/a`，不许估算。**总分不得替代分项基础能力**（第 2 节的推理 / 指令遵循 / 编码执行必须分开取数）。
3. **实测准入**：必须配**未实现对照（对照 = 0）** + 机械判分（pytest 断言 / 精确匹配，非主观评分）+ 每组合 ≥2 次重复。任务**饱和即判「无区分度」，不得据此胜出**。单轮探针预算上限 **1 USD**。
4. **thinking 按实际生效档**：`thinkingLevelMap` / gateway 钳制后的档才算数（例如 provider 把 `xhigh` 坍成 `max`、或对某档返回 400/502）。thinking 变更会改变 tokens/task，不能沿用旧档成本或只按单价推成本。
5. **角色分工**：按成本结构（in / cacheRead / cacheWrite / out 占比）、调用频率、下游返工影响分工；`worker` 与 `reviewer` 保持跨厂商家族；`oracle` 保留顶级模型兜底。
6. **单厂商 profile 不评估**：`free.json` / `ds.json` / `zai.json` 模型不可选，只需跟版本号。

## 要做的事

### 1. 业界基准表（智能 @thinking + per task cost）

列：`model` ｜ 版本/发布 ｜ **thinking 档（AA 实际公布的那档）** ｜ Intelligence Index（含版本号）｜ AA cost/task ｜ tokens/task ｜ 角色相关 benchmark（harness + 版本）｜ 输出速度 ｜ 来源 URL。

优先取角色相关 benchmark（实现/审查类看 agentic/coding；检索类看长上下文与工具调用），不要只堆总分。

### 2. 基础能力指标（复杂任务推理 / 指令遵循 / 编码执行）

总分不替代分项：Intelligence Index 是 9 项加权平均，会把「会推理但守不住格式」和「格式完美但推不动多步」压成同一个数字。三项基础能力各自取数、各自下结论。

| 能力 | 首选 harness（版本必须写） | 判分性质 | 看什么 | 已知缺口 |
|---|---|---|---|---|
| 复杂任务推理 | HLE-Diamond、AA-Omniscience v1.1（net + 幻觉率）、CritPt v2 Hard、GDP.pdf all-pass | 精确答案 / 门槛通过 | 多步链路、抗幻觉、跨文档一致性 | 多数模型只公布默认档；`low` 档普遍无记录 |
| 指令遵循 | IFBench（AA 自跑）、AutomationBench-AA、AA-Briefcase rubric pass | 约束命中（机械） | 字段集/顺序/枚举/禁用词/长度上限 | 新模型 IFBench 大量为 `n/a`，不得用总分或旧模型外推 |
| 编码执行 | Terminal-Bench 4.0、FrontierCode 2.0、SciCode（AA 标 under review，只并列） | 测试通过率 | 终端多轮 agentic vs 单文件补丁 | 跨 harness 不可换算；vendor 自报单列 |

列：`model@档` ｜ 能力 ｜ harness 名 + 版本 ｜ 分数 ｜ 该 eval 的 AA cost/task ｜ 输出 tok/task ｜ 来源 URL。AA 未公布该档 → `n/a`；同一能力下不同 harness **只并列不排序**（TB4.0 与 FC2.0 测的不是同一件事）。

三项能力的作用边界（决定它们能支撑什么结论）：
- **复杂任务推理**：支撑 `oracle` / `plan` 的兜底与契约质量；对 `worker` 只在任务跨模块时才相关。
- **指令遵循**：支撑 `reviewer` 的结构化输出（行号 / 枚举 / JSON 字段）与 `worker` 是否守住 brief 边界。缺数据时用本地机械判分补，不要用 Index 代替。
- **编码执行**：支撑 `worker` 的落地能力，但**饱和任务上没有区分度**——本地满分只说明「不构成否决理由」，不构成选优理由。

缺档时的本地补测口径（机械判分，不与外部口径混用）：
- 指令遵循：单次调用产出受约束的结构化输出（字段集 + 顺序 + 枚举 + 禁用词 + 长度），逐条断言计分；对照 = 无约束散文输出。**对照不会得 0 分**（「无大写」「无禁用词」这类项对任何文本都默认成立），判别力按「候选 − 对照」读，不要拿绝对值当分数。
- 复杂任务推理 / 编码执行：只在外部缺同档数据且该角色真要换档时补测，必须带未实现对照（stub = 0）。
- 每组合 ≥2 次重复；全满分即判饱和、不得据此胜出；单轮预算 ≤1 USD。

### 3. 真实实测表（同任务、同 harness、同判分）

列：角色 ｜ `model@生效档` ｜ 任务与判分方式 ｜ 未实现对照得分 ｜ 重复次数与逐次得分 ｜ 延迟 ｜ 单次 **实收 $** 与 **牌价 $** ｜ 备注（饱和 / 不一致 / 失败原因）。

- 任务必须能区分：**全部满分就换任务或加断言**，不要拿饱和数据写推荐。
- 每个角色至少覆盖「当前配置」+「候选」，缺数据就空着并标 `未验证`。
- 探针脚本内部并行调用以减少测试时间；不要串行跑十几个组合。

### 4. gateway $/task 复算

先用历史 subagent 逐请求 usage（`~/.pi/agent/sessions` 里 subagent 会话的 assistant usage）统计**该角色真实 token 构成**：每请求 in / cacheRead / cacheWrite / out、p50/p90、>100K 与 >272K 占比、每任务请求数。

列：agent ｜ 请求/任务 ｜ token 构成（in/cacheRead/cacheWrite/out）｜ 牌价 $/task ｜ 实收 $/task ｜ 构成来源（历史 usage / 假设 / 区间）。

- context tier 按**逐请求**判定（超阈值整请求跳档）；缺 token 构成时给假设或区间，**不要伪精确**。
- AA 的 cost/task 是外部 workload 估算，不是公司账单，两个口径不得混用。

### 5. 角色推荐表（基于 pi-subagents 内置 agent 的职责范围）

先读内置 agent 定义（`~/.pi/agent/npm/node_modules/pi-subagents/agents/*.md`）确认职责与默认 thinking，再逐个角色给推荐：

`worker`（唯一 writer）、`reviewer`（read-only 校验）、`scout`（压缩上下文侦察）、`researcher`（web 研究）、`oracle`（fork 上下文兜底）、`plan`（契约作者）、`default` / `delegate`。
外部 CLI agent（`claude-code` / `codex-exec` / `cursor-agent`）与 `evidence-auditor` 各占一行写「不适用 + 原因（不吃 gateway 额度等）」。

列：agent ｜ 职责摘要（引 agent md）｜ **推荐 model@档** ｜ 该角色最依赖的基础能力（推理 / 指令遵循 / 编码执行，引第 2 节数据）｜ 依据强度（实测 / 外部基准 / 推算 / 未验证）｜ 备选与不选理由 ｜ 回访条件。

### 6. 未验证与回访

列出：没有同档数据、只跑过 1 次、成本靠假设、依赖上游可变项（路由/折扣/alias 变更）的项，以及每项的灰度方式（预算上限、样本数）与回访触发条件。

## 交付

- 结论写在会话里；需要留档时按「结论 + 依据强度」体例补一节（只写结论、来源、生效档、未验证项，不写过程）。
- **不动 `paid.json` / `settings.json`。** 最后只问两个问题：
  1. 是否把推荐结果同步到 paid profile？（y/n）
  2. 是否执行 `/subagents-load-profile paid`？（y/n）
- 同意同步后，才检查旧模型引用零残留，并单独确认是否 commit / push（push 必须显式批准）。

*Tips: 探针要费用可控——脚本内部并行发请求；单轮总预算不超过 1 USD；任务饱和就立刻换任务，不要在无区分度的数据上继续加跑。*

$@
