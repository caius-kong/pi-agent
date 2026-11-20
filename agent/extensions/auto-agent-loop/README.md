# auto-agent-loop

显式启用的 Agent 续跑监控：每轮结束时用 Flash 总结当前会话，再由 Jev 判断**是否还有已授权、现在可自主执行的必要工作**，决定继续还是停下。

## 命名

Pi 内核自己就用 “agent loop” 指代轮次循环（`pi-agent-core` 的 `agent-loop.js`），本扩展不是那个循环，而是在它之上决定“这一轮结束后是否再续一轮”，所以叫 `auto-agent-loop`：`auto-` 前缀与 `auto-compact` 一致，都表示“条件满足时自动触发”。

写进 session 数据的两个 customType 同属本扩展命名：`auto-agent-loop-state`（开关与续跑计数，resume 时按它找回）、`auto-agent-loop-continuation`（续跑回灌的摘要，总结序列化时排除）。

## 依赖

只使用 Pi 原语，不 import 或加载其他 extension。`pi-subagents` 是**可选集成**：

- 未注册 `subagent` 工具时，不做任何子代理检查，正常判定。
- 注册了 `subagent` 工具时，通过它的内部契约确认 fleet 已结束：`subagents:rpc:v1` status RPC、`tmpdir()/pi-subagents-uid-<uid>/supervisor-channels` 的 request/reply 文件、`PI_INTERCOM_ASK_TIMEOUT_MS` 超时，以及子会话标记 `PI_SUBAGENT_CHILD=1`。
- 这些是 `pi-subagents` 的内部实现，不是公开 API。它升级后若 status RPC 契约变化，本扩展会暂停自动续跑并告警一次，而不是猜测或误续跑；见[已知边界](#已知边界设计取舍非缺陷)。

安装本扩展不会自动安装 `pi-subagents`；需要子代理安全屏障时请单独 `pi install npm:pi-subagents`。

## 为什么需要它

Agent 一轮结束时经常停在半途：用户走开后任务不会自己往下走。Pi 自身没有这个判断层：

- `agent-goal` 只做显示，不干预执行。
- 社区 `@narumitw/pi-goal` 是长任务自主执行系统（每轮注入固定 objective），不判断「是否还有已授权工作」。

因此本扩展只做**动态理解会话**：不维护目标、不注入 objective，每次只看 Pi 当前可见的上下文，判断的是授权和可执行性，而非完成度。

## 使用

```text
/auto-agent-loop on
修复登录问题，并运行回归测试。
后续补充：保留旧 API；暂时不要部署。
/auto-agent-loop status
/auto-agent-loop off
```

- `on`：启用当前 session 的监控，不提交任务、不立即启动 Agent、不重置熔断计数，并清掉上一次判定（`ready` 不显示旧概率或旧错误）。
- `off`：关闭监控；验证进行中关闭会丢弃旧判定。
- `status`：显示开关、Flash/Jev 模型、续跑次数、上次决策/错误，以及完整的 Current Agent State Summary。

Footer 常驻显示 `auto-agent-loop: on` / `auto-agent-loop: off`（status key `auto-agent-loop`），任何时刻都能看出监控是否开启，无需跑 `status`。它只反映开关，不携带判定结果；开启时用 `success` 色、关闭时用 `dim` 色。启动、branch 切换、`on`/`off` 都会刷新这一项。

判定只有一个显示面：每次 settle 后，编辑器上方的 widget（widget key `auto-agent-loop`）保留最后一行判定，形如

```text
auto-agent-loop: ended · Probability(continue)=0.11 ≤ 0.20 · loop 0/3
```

判定不走 `notify`：`notify("info"/"warning")` 渲染在编辑器上方的同一区域，会让同一行出现两次；无 UI 的运行（`pi -p`/RPC）改为写 `console.error`。widget 在 `on`/`off` 和新的用户输入（上一请求的判定已过期）时清除；启动/恢复 session 只恢复开关与续跑计数，判定回到 `ready`，不跨重启存活。它不进模型上下文，只有判定行，不包含摘要正文。

**错误详情看哪里**：widget 那行只给一句话，完整文本在 `/auto-agent-loop status` 的 `Error:` 行（下一次真实用户输入会清掉它）；持久副本在 session 的 JSONL 里 `customType: auto-agent-loop-state` 条目的 `data.error`。超时文案自带阶段与预算（`flash timed out after 300s` / `jev timed out after 300s`，数字取自 `timeout-ms`），所以不用再靠状态里有没有 `summary` 反推卡在哪一步。

新 session 默认关闭；在 `settings.json` 里设置 `"enable": true` 可让每个 session 启动即开启（本机已开启）。恢复 session 时从当前 branch 载入状态。

## 熔断与重置（max-loop）

`max-loop` 按**一次用户请求**计数，不按 session 计数：每续跑一次加一，达到上限进入 `max_loop_limited`。

**触发上限后监控不关闭。** 熔断只停止续跑，`enabled` 仍为 `true`，所以后续 settle 照样进入安全检查，但在该状态下不调用 Flash/Jev（零成本）、也不会自行恢复续跑。一次任务完成、监控仍开启，下一次真实用户请求重新判定。

**只有新的真实用户输入重置计数。** Pi 里 `source` 为 `interactive`（TUI）或 `rpc`（客户端）且不以 `/` 开头的输入，会把续跑次数清零、状态回到 `ready`，该轮 settle 重新完整判定，拿回整个 `max-loop` 预算。语义依据：新请求本身就是新的授权来源，而判定问题始终是「当前是否还有已授权、可自主执行的工作」。

**以下都不重置计数**，否则熔断可被绕过，或把非用户信号当成授权：

| 事件 | 行为与原因 |
|---|---|
| `/auto-agent-loop on` | 计数保留；会重新判定一次，但到达上限后仍是 `max_loop_limited`。手动开监控不是新授权 |
| `/auto-agent-loop off` → `on` | 同上，`off` 只改开关、不动历史计数 |
| 本扩展回灌的 continuation 摘要 | 判定产生的输入不得喂养下一次判定 |
| 工具结果、extension 消息、子代理通知 | 非用户授权 |
| 切换 / 恢复 branch、session 重启 | 从当前 branch 读回持久化计数，回退历史不能绕过熔断 |
| 熔断后的 settle | 不判定、不续跑、不加钱，静等真实输入 |

## 架构

两段式：**Flash 只读杂乱上下文、只总结不决策；Jev 只读干净摘要、只出概率不出文本。** 这样判定器的输入预算与上下文规模解耦。

```text
本轮结束（Pi 当前可见上下文，可能极大且杂乱）
 │
 ├─ 安全前置检查 ──不通过─▶ paused（不调用任何模型）
 │    · 本轮正常完成，最后一条是非 tool_use 的 Agent 回复
 │    · 无既有 continuation / 排队消息 / 未回复 supervisor request
 │    · 有 subagent 工具时，pi-subagents fleet 已全部结束
 ▼
 ① Flash —— 只总结，不决策
    输入：完整原始上下文（不增量、不截断工具结果）
    输出：Current Agent State Summary（≤20k tokens，以 [[SUMMARY-END]] 结尾）
          1 有效要求及变更 · 2 完成证据 · 3 剩余必要工作
          4 授权/等待边界 · 5 未知与冲突
    校验：缺结尾标记或第 3-5 节 ─▶ paused（不调 Jev、不重试）
 ▼
 ② Jev —— 只出概率，不出文本
    输入：摘要 + 判定 instructions/criteria（≤32k tokens）
    问题：是否还有已授权、现在可自主执行的必要工作？
    输出：P(continue) ∈ [0,1]
 ▼
 P ≥ 0.8 且未达 max-loop ─▶ continue：回灌摘要，续跑一轮
 P ≥ 0.8 但已达 max-loop ─▶ max_loop_limited：停止续跑，监控保持开启
 P ≤ 0.2 ─────────────────▶ ended：本轮停止（不是完成声明）
 0.2 < P < 0.8 ───────────▶ uncertain：暂停，等真实用户输入
 模型失败 / 超预算 / 超时 ─▶ error：不续跑，显示原因
```

| 状态 | 含义 | 会继续执行吗 |
|---|---|---|
| `ready` | 已开启，尚无本轮判定 | 否 |
| `continue` | 已授权工作仍在，且未达熔断 | 是，追加一轮 |
| `ended` | 没有可自主继续的必要工作 | 否 |
| `uncertain` | 概率落在中间区间，证据不足以决定 | 否 |
| `max_loop_limited` | 达到 `max-loop` | 否 |
| `paused` | 边界不安全或子代理状态未知 | 否 |
| `error` | 模型/预算/超时失败 | 否 |

判定语义是**「是否还有已授权、现在可自主执行的工作」**，而不是「目标是否达成」。所以输出的是 `P(continue)` 而非 `P(done)`：用「完成度」会隐含「没做完就继续」，在「已按要求停下」「等待用户确认」「明确禁止继续」这些场景下得出相反结论。

## 行为

1. **安全检查** — 只在 `agent_before_settle`（最后可续跑边界，不是 `agent_end`）介入。要求本轮正常完成、无中断、无既有 continuation、无排队消息、无未回复的 supervisor request，最后一条为非 tool-use 的 Agent 回复。有 `subagent` 工具时，通过 `pi-subagents` status RPC 确认 fleet 全部结束；状态未知、超时、快照缺失或有活动任务都暂停。
2. **Flash 总结** — 每次独立总结 **Pi 当前可见上下文**，包含用户、Agent、工具结果、compaction/branch summary 和 custom context；不静默截断工具结果，不建立增量游标，不合并上一份摘要，自身 continuation 里的旧摘要不重复纳入。摘要分五节：有效要求及变更、完成证据、剩余必要工作、授权/等待边界、未知与冲突。
3. **Jev 判定** — `>=0.8` 续跑，`<=0.2` 结束本轮，中间区间 `uncertain` 暂停。等待用户或外部条件、只讨论、已撤销要求、可选改进都不是续跑理由。
4. **续跑或停止** — 高概率时把摘要作为**不可信证据**回灌给 Agent，并要求重新核对实际用户指令。达到 `max-loop` 则 `max_loop_limited`，不关闭监控。
5. **每轮可见** — 判定只走 widget（无 UI 时写 `console.error`，命令回显仍走 `notify`）：`auto-agent-loop: <status> · Probability(continue)=<band> · loop n/m`（`paused`/`error` 时带上原因）。widget 只留判定行，摘要正文留在 `/auto-agent-loop status`。

状态语义：`ended` 只表示本轮不自动续跑，**不是完成声明**。

## 已知边界（设计取舍，非缺陷）

- **Flash 容量以 pi 报告的 context token 为准** — 准入比的是 `ctx.getContextUsage().tokens`（provider 上一次响应的真实 usage，也就是状态栏那个 `37%/1.0M`）加 1024 framing reserve 与 Flash 窗口的差。摘要 transcript 是这份上下文的重新序列化，只少了 thinking 和图片字节，所以这个数偏高不偏低：边界上宁可提前拒绝，不会误放行。没有这个数时（compaction 后到下一次响应之间为 `null`，headless shim 里也没有该 hook）不做准入判断，交给 provider 报错——不拿估算或字节数去猜一个 token 预算。代价是 Jev 的输入不再预先拒绝：摘要本身已被 Flash 的真实 `usage.output` 卡在 20k tokens，Jev 侧的 `usage.input` 也按 provider 计数复查，预检只对窗口 < 21k 的 classifier 才有意义。
- **概率阈值未经目标域校准** — `0.8` 是工程取舍，不是可靠性保证。Jev 返回的概率不等于准确率。
- **摘要完整性靠模型自报结束标记** — 模型可能用干净的 `stopReason` 停在半句，文字本身区分不了“写完”和“被砍断”。因此 prompt 要求以 `[[SUMMARY-END]]` 结尾且必然包含第 3-5 节，缺失即 `paused`：不调 Jev、不重试、不额外花钱。拦截截断的是结尾标记；“第 3-5 节存在”只是辅助检查，正文里的编号子列表可能让它误判为已存在——把握方向不对称：标记缺失一定暂停，标记存在不等于内容无误。
- **超时只说明超时** — 超时是本地合成文案（阶段 + 预算），`abort` 会连带丢掉 provider 的原始报错；只有非超时的失败才保留 provider 的 `errorMessage`。要看“为什么慢”，只能去 provider 侧日志。
- **传输失败按 pi-ai 的策略重试** — Flash 与 Jev 都是只读调用，所以 5xx、408/409/429 和连接中断交给 pi-ai 自带的重试（最多 2 次，退避 0.5s、1s 带抖动，尊重 `retry-after`；其余 4xx 立即失败），不会在第一次 504 上就判 `error`。重试用尽或永久失败仍照原样进 `error` 并保留 provider 文案；`timeout-ms` 仍是硬上限，重试把预算吃光时先触发的是本地超时文案。语义失败（摘要不完整、概率非法）不重试——同样的请求重发一次不会改变结论。
- **一个 deadline 覆盖两个阶段** — Flash 每次重读全部上下文，长会话（数百 KB～MB 级 transcript）里它是唯一会真正超时的一步；`timeout-ms` 同时约束 Flash 与 Jev，慢 Flash 会吃掉 Jev 的预算。单次模型请求的超时取 `timeout-ms + 15s`，只做兵底，保证先触发的是带阶段和预算的本地文案。
- **compaction 已丢失的要求找不回** — 摘要只能基于当前可见上下文；被 Pi compaction 丢弃的要求不会还原。
- **脱敏由模型执行** — 不是确定性隐私过滤器。会话内容会发往配置的模型服务，不适合未授权的敏感上下文。
- **`pi-subagents` 内部契约不兼容时暂停并告警，不旁路** — status RPC 版本/字段、snapshot kind/version 或 event bus 不认识时，暂停自动续跑并告警一次；channel 目录布局没有版本探针，只能按 request/reply 文件是否存在推断（根目录读不到按“仍等待”暂停，单个 channel 消失按“已无人可答”处理）。这是对“不兼容→告警+旁路”偏好的显式例外：旁路会让父会话在子代理仍可能运行时被续跑，风险高于少续跑；降级方向是“少续跑/不阻塞”，不是“猜一个安全结果”。未来协议升级会一直暂停，直到本扩展适配。
- **`/reload` 不重载本扩展代码** — Node ESM 按 URL 缓存模块，改动 extension 后必须重启 pi 进程。只有配置（`settings.json`）是每次重新读取、改完即生效。
- **模型可能回显标题** — 摘要正文偶尔自带 `Current Agent State Summary` 一行，`status` 会看到标题重复；纯显示问题。
- **RPC 是客户端信任边界** — `source: "rpc"` 的输入被当作真实用户输入并重置熔断，无法区分客户端背后的真人与自动程序。

## 成本

- 每个结束轮次：1 次 Flash 总结 + 1 次 Jev 判定。没有轮次结束就不调用。
- Flash 输入是**当前上下文**（不做增量），长会话里这部分是主要开销；输出上限 20k tokens（含 thinking）。
- Jev 输入是该摘要加上判定 instructions 和 criteria，上限 32k tokens。
- 安全条件不满足、判定完成、`uncertain` 或达到熔断时都不额外调用。

## config

集中在 Pi 的 `settings.json`（使用 `PI_CODING_AGENT_DIR` 时跟随 Pi agent directory），键名 `auto-agent-loop`：

```json
{
  "auto-agent-loop": {
    "enable": true,
    "flash-model": "trendmicro/deepseek-v4-flash-0731-gmi-ray",
    "jev-model": "trendmicro/jev-1.13",
    "max-loop": 3,
    "timeout-ms": 300000,
    "flash-thinking": "high"
  }
}
```

上例即 `DEFAULT_CONFIG`（缺少 `auto-agent-loop` 键时的默认值）。本机 `settings.json` 另将 `flash-model` 设为 `trendmicro/deepseek-v4.1-flash`、`timeout-ms` 设为 `600000`。

| 键 | 说明 |
|---|---|
| `enable` | 布尔，默认 `false`；`true` 时每个 session 启动（含恢复）自动开启监控，等价于 `/auto-agent-loop on`。session 内 `/auto-agent-loop off` 仍然生效到该 session 结束，下次启动再按此设置开启 |
| `flash-model` | `provider/model`，在第一个 `/` 处拆分 |
| `jev-model` | 同上；已注册的 classifier 优先，否则走 provider 的 `/systemone` 路由 |
| `max-loop` | 非负整数，本请求最多自动续跑次数；`0` 仍判定但禁止续跑 |
| `timeout-ms` | 正整数，默认 `300000`（5 分钟）；Flash + Jev 共用的总 deadline |
| `flash-thinking` | Flash 总结的 thinking 档位，默认 `high`；取值为 Pi 的档位名（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`），`off` 不发送 reasoning。该档位由 provider 映射成实际 effort，例如 deepseek 风格的网关会收到 `thinking: {type:"enabled"}` + `reasoning_effort` |

Flash 的 thinking 与摘要正文共用 20k 输出上限（`max_completion_tokens`），所以档位越高，留给正文的预算越少；thinking token 同时计入输出计费。长会话里把档位调低是唯一不需要改代码的省成本方式。Jev 是 TypeSafe classifier（`/systemone` 的 state），没有 thinking 概念，不受该键影响。

`controller.mjs` 中的 `DEFAULT_CONFIG` 是缺少 `auto-agent-loop` 键时的默认值。格式错误或显式模型不可用会直接报错（启动时写进 `status` 并告警一次），不静默 fallback、不自行换模型。续跑计数的重置规则见[熔断与重置（max-loop）](#熔断与重置max-loop)。

## 实现

| 文件 | 作用 |
|---|---|
| `index.ts` | 注册入口：`settings.json` 路径、TypeSafe lazy adapter |
| `controller.mjs` | 命令、session/branch 状态、安全屏障、Flash→Jev 管线、预算与 footer/widget 展示 |
| `../../../tests/auto-agent-loop.test.mjs` | 单测：判定、配置、预算与展示 |
| `../../../tests/auto-agent-loop-guard.test.mjs` | 单测：子会话守卫、pending request、重启语义 |

使用 Pi 原语：`pi.on("agent_before_settle" | "input" | "session_start" | "session_tree")`、`pi.registerCommand()`、`ctx.modelRegistry.streamSimple()` / `.classify()`、boundary continuation 与 `custom_message`。无 Herdr 依赖；`pi-subagents` 为可选集成（见[依赖](#依赖)）。
