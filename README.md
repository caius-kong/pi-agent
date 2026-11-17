# my pi agent

基于 [pi coding agent](https://github.com/earendil-works/pi-mono) 的开箱即用个人定制——一键安装脚本装完即可用。

## 安装

`bootstrap.sh` **不做任何交互提问**：所有配置都由显式参数提供，缺什么就报错并指出缺哪个参数。因此下面的场景可以直接复制执行，也可以由 agent 照本文档驱动完成安装。

一行式安装（`-s --` 之后的参数会传给脚本）：

```bash
curl -fsSL https://raw.githubusercontent.com/caius-kong/pi-agent/main/bootstrap.sh | bash            # 零参数
curl -fsSL https://raw.githubusercontent.com/caius-kong/pi-agent/main/bootstrap.sh | bash -s -- --default-provider zai   # 带参数: 必须 -s --
```

### 参数

哪一种调用都行，参数只做加法：不带任何参数也能装成一个可用的 pi（只缺凭据）。

| 参数 | 作用 | 默认 |
|---|---|---|
| *（无参数）* | 装 pi + 本仓库配置，保留 repo 默认 provider/model，不写凭据 | — |
| `--default-provider <p>` | 配置这一个 provider 并设为默认（决定默认模型 + subagents profile） | — |
| `--providers <a,b,...>` | 配置多个：`deepseek`、`zai`、`trendmicro`，逗号分隔 | 由 `--default-provider` 推出；都没给则不配 provider |
| `--keys-file <path>` | `KEY=VALUE` 凭据文件（见下） | 只读环境变量 |
| `--hindsight-api-url <url>` | 接入已部署的 Hindsight API；只有给了它才安装 Hindsight client | 不安装 |
| `--hindsight-token-file <path>` | Hindsight token 文件（取首行） | 读 `HINDSIGHT_API_TOKEN` |
| `--rtk <install\|skip>` | 缺 rtk 二进制时是否跑官方 installer | `install` |
| `--ponytail-mode <off\|lite\|full\|ultra\|skip>` | 写入 ponytail `defaultMode` | `off` |
| `-h`, `--help` | 参数速查 | — |

### 常见场景

1. **全新机器，先装再说**：`./bootstrap.sh`（之后 `pi auth check --provider <p>`，或带参数重跑补凭据）
2. **单 provider + 凭据**：`./bootstrap.sh --default-provider trendmicro --keys-file ~/.config/pi/keys.env`
3. **多 provider**：`./bootstrap.sh --providers deepseek,zai,trendmicro --default-provider zai`
4. **接入 Hindsight**：`HINDSIGHT_API_TOKEN=<key> ./bootstrap.sh --hindsight-api-url https://<machine>.<tailnet>.ts.net`（token 也可放文件：`--hindsight-token-file ~/.config/pi/hindsight.token`）
5. **已装机器刷新 / 只换默认 provider**：重跑同一命令即可（`git pull --ff-only` + 补装 packages + 重写默认模型）
6. **离线或不装 rtk**：追加 `--rtk skip`；不想让脚本改 ponytail 配置：追加 `--ponytail-mode skip`

### 凭据

- 不给任何 provider 参数时**完全不碰凭据**，只写 pi 与 repo 配置。
- 解析顺序（给了 provider 时）：`~/.pi/agent/auth.json` 已有该 provider → `--keys-file` 条目 → 同名环境变量。都没有则跳过该 provider（若它是默认 provider，直接报错退出，不写任何配置）。
- 变量名：`DEEPSEEK_API_KEY`、`ZAI_API_KEY`、`OPENAI_API_KEY`（trendmicro 用后者）；Hindsight 用 `HINDSIGHT_API_TOKEN`。
- **任何凭据都不进命令行参数**。落盘位置：`~/.pi/agent/auth.json`（0600）、`~/.hindsight/coding-agent.json`（0600，目录 0700），token 也不会传给 installer 的命令行。
- `deepseek`/`zai` 自费申请（[DeepSeek](https://platform.deepseek.com/) / [Z.AI](https://z.ai/)，GLM 官方 provider）；`trendmicro` 是公司网关 key。

### 脚本做了什么

- **`~/.pi`**：不存在则 clone；已存在且 origin 是本 repo 则 `git pull --ff-only`；origin 不匹配则报错，不动现场。
- **packages / 模型**：`pi install` 装 `agent/settings.json` 声明的 `packages`；按默认 provider 写默认模型与 subagents profile（`trendmicro` 保留仓库原配置）。
- **rtk 二进制**：仓库只带 `agent/extensions/rtk.ts`，二进制需单独装。扩展在、PATH 缺 rtk 且 `--rtk install` 时跑官方 [install.sh](https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh)（自带 SHA-256 校验，不要设 `RTK_SKIP_CHECKSUM` 绕过），装到 `~/.local/bin`；已有 rtk 不覆盖；失败不中止，只报告（扩展会自行禁用）。装到 `~/.local/bin` 但不在 PATH 时同样报告。
- **ponytail 模式**：ponytail 的 pi 集成**不读** `settings.json`，只认 `PONYTAIL_DEFAULT_MODE` 和 `$XDG_CONFIG_HOME/ponytail/config.json`（回退 `~/.config/ponytail/config.json`）。脚本仅在 ponytail 已声明为 package 时写 `defaultMode`，保留文件其他键，值不同则先备份 `config.json.bak.<时间戳>` 再改写。
- **自检**：结束时打印关键文件、rtk、ponytail、Hindsight endpoint 的状态。

### 已知约束

- **平台**：`bootstrap.sh` 目前**仅在 macOS 上验证**过，未在 Linux 等其他系统测试。
- **`agent/settings.json` 有本地改动**时刷新会被拦截（`git pull` 可能冲突）：先 `git -C ~/.pi checkout -- agent/settings.json` 再重跑（脚本会按参数重新写入 provider、模型与扩展）。装了 Hindsight 后该文件必然出现本地改动，重跑时要带上原来的 `--hindsight-api-url`，否则扩展登记会丢。
- Hindsight server 部署与旧数据迁移见 [Hindsight SOP](docs/hindsight-pi-deployment.md)。

## 个人定制（随仓库携带，开箱即用）

- **extensions**：官方/社区/个人自定义扩展（记忆、子代理、网页访问、goal 等），经 `pi install` 声明式安装
- **prompt templates**：沉淀的工作流模板
- **models**：模型目录以及 pi-subagent profiles
- **AGENTS.md**：反复锤炼的行为准则与个人偏好

## 自定义 Extensions

社区未找到符合需求且低风险的 extension，因此选择自行扩展。各扩展的设计决策、选型对比、验收细节见对应的 `README.md`。

| 扩展 | 类型 | 一句话功能 | 命令/配置 |
|---|---|---|---|
| **notify** | 通知 | agent settle 后发一次系统通知（macOS/Linux/Herdr） | `terminal-notifier` 权限 |
| **agent-goal** | 显示 | 实时显示主代理当前目标 + 最后用户 prompt（编辑器上方 widget） | `/agent-goal on\|off` |
| **auto-agent-loop** | 续跑控制 | Flash 总结会话状态，Jev 判断是否还有已授权可自主执行的必要工作；有则续跑 | `/auto-agent-loop on\|off\|status`、`settings.json` 的 `auto-agent-loop` 键 |
| **permission-gate** | 安全 | 官方 example 深度改写: hard-deny 底线 + YOLO 模式（会话级，或 `permission-gate.yolo` 持久开启，默认 false）+ allowlist + git force-push 语义；YOLO 生效时 footer 显示 `yolo: on` | `/yolo`、`permission-gate.yolo` in `settings.json`、`~/.pi/agent/permission-gate-allowlist.json` |
| **session-budget** | 成本 | settings 驱动的会话成本硬上限（含 subagent） | `sessionBudget` in `settings.json`、`/budget [usd\|off]` |
| **auto-compact** | 成本/性能 | context 超阈值时由模型选择安全检查点压缩，并在 Pi boundary 续跑；带 `cost.tiers` 的模型（如 `gpt-6.1-sol` 在 272k input tokens 后单价翻倍）阈值自动压到 tier 边界之下 | `/auto_compact [0-100\|off]`、`settings.json` 的 `auto_compact` 键（`compressionThresholdPercent` 默认 `40`、`enableCostTiersOverrideThreshold` 默认 `true`） |
| **system-prompt-header** | 显示 | footer 显示当前 system prompt 的估算 token 数（chars/4，与 pi 的 context 统计同口径） | — |

### footer 状态行

各扩展 `ctx.ui.setStatus()` 的内容拼成 footer 的最后一行：**按状态 key 字母序排列**，**不换行**，超宽从尾部截断（`truncateToWidth`，尾缀 `...`）。当前顺序：

`yolo: on` → `auto-agent-loop: on|off` → `● 🐴 ponytail: ⚡ FULL` → `Budget $x / $y` → `System: ~Nk tok`（子代理运行期间在 `Budget` 之后临时插入 `running...` / `12 tools bash`）

加新状态时，key 名就是唯一的排序手段（例如 `agent-yolo` 正好排在 `auto-agent-loop` 前）；把必须看见的放前面，因为被截掉的是尾部。目标类信息走 widget（编辑器上方），不占这唯一的一行。

## 测试

测试命令与约束见 [AGENTS.md](./AGENTS.md)。

`tests/session-budget-fork*.test.mjs` 静态 import `agent/npm/node_modules/jiti`，而 `agent/npm/` 不随仓库携带。fresh clone 直接跑会有两个文件 `ERR_MODULE_NOT_FOUND`；先跑一次 `./bootstrap.sh`（或 `pi install`）再跑测试即可全通过。

## Skills 不随仓库

skills 属个人偏好，本仓库不携带，按需自行取用：

- https://github.com/caius-kong/skills
- https://github.com/mattpocock/skills
- https://github.com/anthropics/skills
