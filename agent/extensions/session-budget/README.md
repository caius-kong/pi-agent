# session-budget

`settings.json` 驱动的 main-session 成本硬上限，统计口径包含 main + subagent。

## 为什么需要它

社区三包均不满足需求：
- `@bacnh85/pi-budget` 只认 CLI `--budget` 且**明确不含 subagent**
- `pi-budget-guard`/`pi-agent-budget` 只监听父 session 的 `message_end`，**漏掉**持久化在 toolResult 上的 subagent usage

故自研 session-budget extension。

## 行为

### 成本口径

main agent + sync/async subagent（无论 fresh/fork context）以及 fork ledger 新增用量（含 compaction / branch summary）——为 pi 自带 footer 口径的**超集**。

**为什么需要补计（截至 2026-09-23，pi 0.87.0）：** pi 的 statusline / `/session` / `get_session_stats` 只统计主会话自己条目的 cost——即 main agent + sync subagent——**不包含 async subagent**。而 async 是默认派发方式：其完成通知是一条不带 usage 的自定义消息，成本只留在子会话文件里。实测某会话 statusline 显示 $3.49，实际 $63.4。

**fork 账本去重：** fork 是其父会话的分支而非新的计费历史，只按 entry lineage 计入其**新增**条目（继承条目按 id 去重，不重算）。若自相矛盾（缺 id、重复 id、继承条目计费数据被改写、无法解析），本扩展不会把未知支出当作 0 报出去，也不会 abort 会话——它判定自己已经不认识这份数据，转入下面的「兼容旁路」。

**run 目录里的 `.jsonl` 未必是账本：** `pi-subagents` 会在同一目录写 `subagent-artifacts/*_transcript.jsonl`（无 `type: "session"` 头，内容是子会话消息的回放，其花费已由子会话自己的 `session.jsonl` 计入）。这类文件一律跳过；仍在写入的半行 header 留到下次扫描。跳过不代表不认识——只有在「带计费条目却没有 session 头」「账本里有读不出的行」时才算兼容性证据。

**兼容门（happy path / 旁路）：** 子会话与 fork 的扫描就是 happy path，它是**对着某一个 `pi-subagents` 布局写出来的**。两种模式，二选一，不存在中间态：

- **happy path**：能完整读出所有子账本与 fork 账本 → 精确记账（含 fork 增量去重、integrity 自检）。
- **旁路**：出现第一条"这份数据不是那套布局"的证据（无法归类的计费行、读不出行、扫描抛错）→ **本次会话放弃整个子会话/fork 记账**，只计 main agent，金额标注 `(subagent excluded)`，并告警一次。旁路在本会话内保持（磁盘上的文件不会自己修好），新会话重新判定。

**为什么旁路是"整个放弃"而不是"跳过坏行继续算"：** 部分结果看起来是完整的，会让人误信这个 cap 真的覆盖了 subagent。宁可明说"没算"，也不给一个悄悄偏低、却长得像完整的数字。

详细推导（W/A/C/U/F、去重与增量解析）见 `index.ts` 顶部注释。

### 检查点

| 事件 | 作用 |
|---|---|
| `turn_start` | 已超限会话新 turn 立即拦（queue 的 steering/follow-up 进不来） |
| `tool_result` | turn 中途止损 |
| `turn_end` | 兜底 |

`enforce` 只由 main session 执行：主会话汇总 main + sync/async subagent（无论 fresh/fork context）的费用并在超限时 abort 自己。subagent 不执行自己的 session cap，也不能修改父会话预算；fork 继承的历史账单不会单独触发子代理 abort。配置为 `off`/未配置/非法配置时 main session 扩展静默。main session 执行 `/budget off` 后显示 `Budget off`；`/budget off` 和 `/budget <usd>` 仅在当前运行中生效，不写入 settings 或 session ledger，重新启动或 resume 后重新按 settings 配置执行。`/budget <usd>` 与 `/budget` 查看聚合费用也只由 main session 执行。无关独立 session 不继承，按各自 settings 执行。

### 性能 / 依赖

子会话扫描走缓存 + 增量读，且只在「能改变判定」时校验（turn 边界、启动、`/budget` 必检；`tool_result` 仅当接近上限且距上次 ≥ 2s 才检）。文件解析复用已缓存的增量账目，但 turn 边界会重新遍历子会话目录，扫描开销随子会话树规模增长。

**Subagent 计费前提：必须另行安装并启用 `pi-subagents`。**Pi 不会根据一个 Pi package 的代码引用自动级联安装另一个 Pi package；安装本扩展不会自动安装 `pi-subagents`。请单独运行 `pi install npm:pi-subagents`。本扩展不 import `pi-subagents` 模块或读取其配置，但完整的 subagent 费用聚合依赖它写出的 on-disk session 布局、同步 tool-result 中的 `details.runId` / `details.asyncId` 和 `results[].sessionFile`，以及 fork session header 的 `parentSession` lineage。未安装/启用它时，main session 自身费用仍可统计，但 subagent 费用不计，不能把该 cap 当作完整的 main + subagent 硬上限；布局或字段变化会让本扩展转入上面的兼容旁路（告警 + 只计 main agent）。

**依赖版本：`pi-subagents` 0.81.0（`index.ts` 里的 `SUBAGENTS_EXPECTED_VERSION`）。**上面的布局/字段契约是跟这一个版本对齐验证出来的。这个常量表示「**已验证**的版本」，不是「当前安装的版本」——两者不一致时不要为了让告警消失而改它。

`0.81.0` 已在本机验证（2026-10-23）：run 目录布局不变（`<runId>/run-0/session.jsonl`，首行 `type:"session"`），`details.runId` 仍在，**完成的 attached 结果仍带 `results[].sessionFile`**。实测到一处差异：**detached** 结果不再有 `results[].sessionFile`，改用 `transcriptPath` / `sessionName`；此类去重走 `details.runId`（仍在），子会话仍只计一次，并有测试钉住。所以 pin 升到 0.81.0。

仍要守的纪律：pin 表示「**已验证**的版本」，不是「当前安装的版本」；升级后必须按 Troubleshooting 重新验证，不要为了让告警消失而改它。

本扩展是共享扩展，不能假设用户装的就是这个版本；但**版本号不同本身不是不兼容的证据**（`pi-subagents` 升级很频，大多数不动布局）。所以判定不靠版本号，靠**扫描时实际遇到、但归不到这套布局上的数据**：

- 子会话账本里出现读不出来的行；
- run 目录里有带计费条目的 JSONL，却没有 `type: "session"` 头（账本位置/格式变了）。

一旦出现这类证据，转入**旁路**并发**一份兼容性报告**：装的是哪个版本、验证的是哪个版本、具体哪个文件哪一行，并给出两个选择——**把 `pi-subagents` 同步回受支持的版本**（恢复完整记账），或**保留升级但接受 subagent 不计费**（此时 cap 只覆盖 main agent）。报告走 `console.warn` + TUI 警告，每会话一份；`/budget doctor` 可随时重放这份自检。**旁路不等于 abort**：会话照常继续，只是不报 subagent 花费。

想真正让本扩展支持新版本，是你主动发起的一次升级，流程见下方 [Troubleshooting](#troubleshooting-升级到新的-pi-subagents)。

普通 transcript 旁支文件不算证据（会被跳过但不报告）；未安装 `pi-subagents` 也不算。旁路期间状态栏与 `/budget` 文案都会标出 `subagent excluded`，直到新会话或版本修好。

**Optional integration — `pi-subagents` async stop：自动 best-effort，无需额外配置。**达到 cap 时，若其 RPC event bus 可用，就发 status/stop 请求；RPC 缺失、超时或 stop 失败只记日志且不延迟 parent abort。Stop acknowledgement 不证明 child 已终止。此 RPC 是停止子代理的可选集成；它不改变上面的安装前提——subagent 费用聚合仍依赖 `pi-subagents`。

## 配置

```json
// agent/settings.json
"sessionBudget": {
  "maxCostUsd": 5,
  "mode": "enforce"
}
```

项目级 `.pi/settings.json` 同名键覆盖（需项目 trust）。只有 main session 使用 `/budget <usd>` 设置/恢复当前运行的聚合上限，使用 `/budget off` 临时关闭当前运行的限制，使用 `/budget` 查看包含子代理的聚合用量，或使用 `/budget doctor` 对 `pi-subagents` 依赖做一次自检（版本 + 每个子账本的分类，只读、不 abort）；subagent 的 `/budget` 不改变限额。命令覆盖仅在内存中维持，不持久化；新启动或 resume 后按 settings 重新加载限额。

## Troubleshooting：升级到新的 pi-subagents

模型/维护者可直接按本节执行。触发场景：出现 `Session budget: this accounting is incompatible with the installed pi-subagents ...` 告警，状态栏/`/budget` 出现 `subagent excluded`，或 `/budget doctor` 报出 `BILLED ENTRIES WITHOUT A SESSION HEADER` / 读不出的账本行。

此时本扩展处在**兼容旁路**：会话照常跑，只是 subagent 花费完全不计。这不是 bug 状态，是设计好的降级——happy path 是"对着当前安装版本写出来的"，认不出就当不认识，绝不 abort，也绝不报一个看着完整、实则缺一块的数字。

### 0. 先判断要不要修

告警本身给了两个选项，任选其一，不需要立即改代码：

- **同步版本**：`pi install npm:pi-subagents@<SUBAGENTS_EXPECTED_VERSION>`，恢复完整记账（推荐给只想止损的用户）。
- **忽略**：保留新版，接受 subagent 不计费。此时 cap 只覆盖 main agent，状态栏会持续显示 `(subagent excluded)`。

只有当你想让本扩展**支持**已装的新版时，才继续往下走（第 1 步起）。

### 1. 自检：确认到底哪里变了

```bash
cd ~/.pi
/budget doctor            # 在 pi 里运行：装的是哪个版本、验证的是哪个版本、每个子账本被判成什么
node --test tests/        # 现有契约是否还全绿
```

`doctor` 输出会逐文件给出分类：`ledger (counted)` / `not a ledger (skipped ...)` / `BILLED ENTRIES WITHOUT A SESSION HEADER ...` / `header still being written`。**只有后两类（BILLED ENTRIES、读不出的行）才是兼容性证据**；transcript 旁支文件被跳过是正常现象。

再用真实数据看新版到底写了什么（挑最近一个带子会话的会话目录）：

```bash
d=~/.pi/agent/sessions/--Users-caius_kong-.pi--     # 换成实际项目目录
latest=$(ls -t "$d"/*.jsonl | head -1); echo "$latest"
ls "$(basename "$latest" .jsonl)"                   # 看 run-N / forks / subagent-artifacts 布局
for f in $(find "$(dirname "$latest")/$(basename "$latest" .jsonl)" -name '*.jsonl' | head -20); do
  printf '%s\n  first line: %s\n' "$f" "$(head -c 200 "$f")"
done
```

### 2. 对照本扩展读的四条契约

happy path 的写法是：**先对着当前安装的 `pi-subagents` 把读取逻辑写对、跑通、测准**，再在它外面套兼容门（`enterCompatBypass`）。所以修适配时只动 happy path 里的读取逻辑，不要在 happy path 内部加"读不出来就返回 0"的分支——那会把两种语义混在一起，让旁路判定失真。

`index.ts` 里对应位置，改成新版实际形状：

| 契约 | 现在期望（0.81.0） | 相关代码 |
|---|---|---|
| 子会话账本路径 + 首行 header | `run-N/**/*.jsonl`，首行 `{"type":"session",...}` | `childSessionFiles()`、`jsonlKind()`、`readChildLedger()` |
| toolResult 里的 run 标识 | `details.runId` / `details.asyncId` | `accountedRunIds()` |
| toolResult 里的子会话文件 | `results[].sessionFile`、`completions[].results[].sessionFile` | `accountedRunIds()`、`subagentResults()` |
| fork lineage | fork 文件首行 `parentSession` 指向父会话文件 | `readForkSession()`、`scanForkSessions()` |

改的时候保持两条既有约束，否则会引入新 bug：

- **不要给 happy path 加"半途放弃"分支**：读不出/认不出 → 整块交给兼容门转旁路（`enterCompatBypass`），happy path 内部保持"要么全读、要么整体不报"。
- **旁路必须永远比 abort 优先**：会话继续、金额只计 main agent、告警一次；只有"连 main agent 的条目都拿不到"才允许中止。
- **不要为了新版本删掉旧版本兼容**：`jsonlKind()` + `readChildLedger()` 已经能同时处理"是账本 / 不是账本 / 还没写完"，只在契约真正变化处改判据。

### 3. 补测试 → 改常量 → 全绿

```bash
cd ~/.pi
# 3.1 为新形状加 pin 测试（tests/session-budget-fork.test.mjs）：
#     - 新版布局能被计入（金额精确到分）
#     - 旧版布局仍不被误判为不兼容
# 3.2 只有确认新版可用后，才更新 index.ts 里的常量：
#     const SUBAGENTS_EXPECTED_VERSION = "<新版本>";
#     测试会读取该常量，不要绕过它
node --test tests/                     # 必须 100% 绿
node --test tests/session-budget-fork-realdata.test.mjs   # 真实会话对账（可用 SB_REALDATA_SESSION=<file> 指定）
```

### 4. 用真实会话验收

```bash
SB_REALDATA_SESSION=<某个真实会话 jsonl> node --test tests/session-budget-fork-realdata.test.mjs
```

它用独立参照实现重算 W/F 并与本扩展的判定做二分比对；新旧布局都跑一遍，确认新版计入、旧版不回归。最后在 README 的"依赖版本"段把版本号与契约表一起更新。

## 实现

| 文件 | 作用 |
|---|---|
| `index.ts` | 核心逻辑：成本聚合、fork lineage、budget enforcement、`/budget` 命令、RPC stop best-effort |
| `../../../tests/session-budget-fork.test.mjs` | fork 账本与聚合单测：`node --test tests/session-budget-fork.test.mjs` |
| `../../../tests/session-budget-fork-realdata.test.mjs` | 真实会话对账，可用 `SB_REALDATA_SESSION=<file>` 指定：`node --test tests/session-budget-fork-realdata.test.mjs` |