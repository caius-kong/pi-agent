# my pi agent

基于 [pi coding agent](https://github.com/earendil-works/pi-mono) 的个人定制仓库：`bootstrap.sh` 装完 pi、配置与 packages 即可用。

## 安装

`bootstrap.sh` 全程非交互：所有配置只由参数提供，缺什么就报错并指出缺哪个参数。因此它既能直接复制执行，也能由 agent 照本文档驱动。

```bash
curl -fsSL https://raw.githubusercontent.com/caius-kong/pi-agent/main/bootstrap.sh | bash            # 零参数
curl -fsSL https://raw.githubusercontent.com/caius-kong/pi-agent/main/bootstrap.sh | bash -s -- --default-provider zai   # 带参数: 必须 -s --
```

管道调用时只有 `-s --` 之后的参数会传给脚本。

### 参数

参数只做加法：零参数也能装成一个可用的 pi，只缺 provider 凭据。

| 参数 | 作用 | 默认 |
|---|---|---|
| *（无参数）* | 装 pi + 本仓库配置，保留 repo 默认 provider/model，不写凭据 | — |
| `--default-provider <p>` | 配置该 provider 并设为默认，决定默认模型与 subagents profile；单独使用时等价于只配这一个 | — |
| `--providers <a,b,...>` | 要配置的 provider：`deepseek`、`zai`、`trendmicro`，逗号分隔 | 取 `--default-provider`；都没给则不配 provider |
| `--keys-file <path>` | `KEY=VALUE` 凭据文件，必须同时给出 provider 参数 | 只读环境变量 |
| `--hindsight-api-url <url>` | 接入已部署的 Hindsight API 并安装 client；只接受 HTTPS（本机 loopback 可用 HTTP） | 不安装 |
| `--hindsight-token-file <path>` | Hindsight token 文件（取首行） | `HINDSIGHT_API_TOKEN` |
| `--rtk <install\|skip>` | 缺 rtk 二进制时是否跑官方 installer | `install` |
| `--ponytail-mode <off\|lite\|full\|ultra\|skip>` | 写入 ponytail `defaultMode` | `off` |
| `-h`, `--help` | 参数速查 | — |

典型调用：

```bash
./bootstrap.sh                                                      # 先装起来，之后补凭据
./bootstrap.sh --default-provider trendmicro --keys-file ~/.config/pi/keys.env
./bootstrap.sh --providers deepseek,zai,trendmicro --default-provider zai
HINDSIGHT_API_TOKEN=<key> ./bootstrap.sh --hindsight-api-url https://<machine>.<tailnet>.ts.net
./bootstrap.sh --rtk skip --ponytail-mode skip                       # 不装 rtk、不改 ponytail 配置
```

重跑同一命令即刷新已装机器：`git pull --ff-only` + 补装 packages + 重写默认模型。

### 凭据

- 不给任何 provider 参数时完全不碰凭据，只写 pi 与 repo 配置。
- 解析顺序（给了 provider 时）：`~/.pi/agent/auth.json` 已有该 provider → `--keys-file` 条目 → 同名环境变量。都没有则跳过该 provider；若它正是默认 provider，直接报错退出，不写任何配置。
- 变量名：`DEEPSEEK_API_KEY`、`ZAI_API_KEY`、`OPENAI_API_KEY`（trendmicro 用后者）、`HINDSIGHT_API_TOKEN`。
- 凭据不进命令行参数，也不传给任何 installer 的 argv。落盘位置：`~/.pi/agent/auth.json`（0600）、`~/.hindsight/coding-agent.json`（0600，目录 0700）。
- `deepseek`/`zai` 自费申请（[DeepSeek](https://platform.deepseek.com/) / [Z.AI](https://z.ai/)）；`trendmicro` 是公司网关 key。

### 脚本行为

- **`~/.pi`**：不存在则 clone；已存在且 origin 是本 repo 则 `git pull --ff-only`；origin 不匹配则报错退出，不动现场。
- **packages 与模型**：`pi install` 安装 `agent/settings.json` 中 `packages` 声明的项；按默认 provider 写默认模型与 subagents profile（`trendmicro` 保留仓库原配置）。
- **rtk 二进制**：仓库只带 `agent/extensions/rtk.ts`，二进制需单独装。扩展在、PATH 缺 rtk 且 `--rtk install` 时跑官方 [install.sh](https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh)（自带 SHA-256 校验，不要设 `RTK_SKIP_CHECKSUM` 绕过），装到 `~/.local/bin`；已有 rtk 不覆盖；失败不中止，只报告，扩展自行禁用。
- **ponytail 模式**：ponytail 的 pi 集成不读 `settings.json`，只认 `PONYTAIL_DEFAULT_MODE` 和 `${XDG_CONFIG_HOME:-~/.config}/ponytail/config.json`。脚本仅在 ponytail 已声明为 package 时写 `defaultMode`，保留文件其他键，值不同则先备份 `config.json.bak.<时间戳>` 再改写。
- **Hindsight client**：跑官方 installer 装 pi 集成并写入 endpoint 与 token；上游运行时的 `before_agent_start` prompt 兼容补丁按探测结果打，幂等，上游修好后自动跳过。
- **自检**：结束时打印关键文件、rtk、ponytail、Hindsight endpoint 状态，并 `pi list`。

### 已知约束

- **平台**：`bootstrap.sh` 只在 macOS 上验证过，Linux 等其他系统未测。
- **`agent/settings.json` 有本地改动时刷新会被拦截**（`git pull` 可能冲突）：先 `git -C ~/.pi checkout -- agent/settings.json` 再重跑，脚本会按参数重新写入 provider、模型与扩展。装了 Hindsight 后该文件必然出现本地改动，重跑时要带上原来的 `--hindsight-api-url`，否则 Hindsight 扩展登记会丢。
- Hindsight server 部署与旧数据迁移见 [Hindsight SOP](docs/hindsight-pi-deployment.md)。

## 仓库内容

- **extensions**：自定义扩展（见下）；`packages` 中的官方/社区扩展经 `pi install` 声明式安装
- **prompt templates**：沉淀的工作流模板
- **models**：模型目录与 pi-subagent profiles
- **herdr-plugins**：Herdr 插件，`bark-notify` 把 Herdr 的 agent 状态变化推到 Bark（iOS）
- **AGENTS.md**：行为准则与个人偏好

skills 属个人偏好，不随仓库携带，按需自取：

- https://github.com/caius-kong/skills
- https://github.com/mattpocock/skills
- https://github.com/anthropics/skills

## 自定义 Extensions

社区扩展不满足需求处自行扩展，各扩展的设计决策、选型对比与验收细节见对应的 `README.md`。

| 扩展 | 类型 | 一句话功能 | 命令/配置 |
|---|---|---|---|
| **notify** | 通知 | 会话真正静默（无自动续跑、无排队消息、无运行中的后台子代理）后发一次系统通知（macOS/Linux/Herdr） | `terminal-notifier` 权限 |
| **agent-goal** | 显示 | 编辑器上方 widget 显示主代理当前目标 + 最后用户 prompt，纯显示不干预执行 | `/agent-goal on\|off` |
| **auto-agent-loop** | 续跑控制 | Flash 总结会话状态，Jev 判断是否还有已授权可自主执行的必要工作；有则续跑 | `/auto-agent-loop on\|off\|status`、`settings.json` 的 `auto-agent-loop` 键 |
| **permission-gate** | 安全 | 官方 example 深度改写：hard-deny 底线 + YOLO 模式（会话级，或 `permission-gate.yolo` 持久开启，默认 false）+ allowlist + git force-push 语义；YOLO 生效时 footer 显示 `yolo: on` | `/yolo`、`permission-gate.yolo` in `settings.json`、`~/.pi/agent/permission-gate-allowlist.json` |
| **session-budget** | 成本 | settings 驱动的会话成本硬上限（含 subagent） | `sessionBudget` in `settings.json`、`/budget [usd\|off]` |
| **auto-compact** | 成本/性能 | context 超阈值时由模型选择安全检查点压缩，并在 Pi boundary 续跑；对 `cost.tiers` 声明了请求级 input 涨价边界的模型，阈值自动压到该边界之下 | `/auto_compact [0-100\|off]`、`settings.json` 的 `auto_compact` 键（`compressionThresholdPercent` 默认 `40`、`enableCostTiersOverrideThreshold` 默认 `true`） |
| **system-prompt-header** | 显示 | footer 显示当前 system prompt 的估算 token 数（chars/4，与 pi 的 context 统计同口径） | — |

单文件扩展（`agent/extensions/*.ts`，如 `bookmark`、`git-checkpoint`、`protected-paths`、`rtk`，以及 Herdr/Orca 集成）没有独立 README，行为见文件头注释；`herdr-agent-state.ts`、`orca-*.ts` 由对应集成安装并覆盖，改动写在这些文件之外。

### footer 状态行

各扩展 `ctx.ui.setStatus()` 的内容拼成 footer 的最后一行：**按状态 key 字母序排列**，**不换行**，超宽从尾部截断（`truncateToWidth`，尾缀 `...`）。当前顺序：

`yolo: on` → `auto-agent-loop: on|off` → `● 🐴 ponytail: ⚡ FULL` → `Budget $x / $y` → `System: ~Nk tok`（子代理运行期间在 `Budget` 之后临时插入 `running...` / `12 tools bash`）

加新状态时，key 名就是唯一的排序手段（例如 `agent-yolo` 正好排在 `auto-agent-loop` 前）；把必须看见的放前面，因为被截掉的是尾部。目标类信息走 widget（编辑器上方），不占这唯一的一行。

## 测试

全量：`node --test tests/*.test.mjs`；测试约定见 [AGENTS.md](./AGENTS.md)。

`tests/session-budget-fork*.test.mjs` 静态 import `agent/npm/node_modules/jiti`，而 `agent/npm/` 不随仓库携带：fresh clone 下这两个文件报 `ERR_MODULE_NOT_FOUND`。先跑一次 `./bootstrap.sh`（或 `pi install`）再跑测试即可全通过。
