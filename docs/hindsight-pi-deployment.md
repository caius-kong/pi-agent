# Hindsight server SOP：部署 → 接入 Pi → 运维

给 LLM 执行用。读完应能独立完成：① 按官方指南部署一台 Hindsight server；② 可选地把旧实例数据迁过来；③ 把 Pi client 接上。

## 0. 原则

- **部署以官方文档为准**，采用官方 external-pg `docker-compose` 方式。本仓库**不复制、不维护**官方 compose 副本：需要时现下载，只按 §1.1 改。
- 本文只写四类内容：与官方的差异（含原因）、官方文档没写的踩坑结论、可执行步骤、验收与排障。历史叙述留给提交信息。
- 锁版本（不用 `latest`）；secrets 只写 server 的 `.env`（`0600`）；API/UI 只绑 loopback；永不用 `compose down -v`。

## 1. 部署

官方：[Installation](https://hindsight.vectorize.io/developer/installation) · [Configuration](https://hindsight.vectorize.io/developer/configuration) · [external-pg compose](https://github.com/vectorize-io/hindsight/blob/main/docker/docker-compose/external-pg/docker-compose.yaml)。Quick Start 的 `docker run` + 内嵌 pg0 只适合试跑。

1. 资源：VM **≥8 GiB** / ≥4 vCPU，并在扣除 PG 后给 API 留 ≥2 GB 余量。API 进程稳态 RSS 3.4–4.2 GB（ONNX embedding + flashrank + MCP 与控制台 UI 同容器），PG 另占 ~0.6 GB；VM 无 swap，余量不足时突发（consolidation / reflect / 页面刷新）会被内核 OOM kill，症状是 502 抖动而不是报错（§3.5）。macOS 用 Podman：`podman machine init --cpus 4 --memory 8192 hindsight && podman machine start hindsight`（登录后自启见 [Podman macOS autostart](https://github.com/containers/podman/blob/main/docs/tutorials/macos_autostart.md)）。宿主机在扣除 VM 占用后仍须够日常使用——macOS 默认无 swap。
2. 取官方 external-pg compose 到部署机的 `~/.config/hindsight-podman/compose.yaml`，按 §1.1 逐条修改，**其余保持官方原样**。
3. `~/.config/hindsight-podman/.env`（目录 `0700`、文件 `0600`）：
   ```dotenv
   HINDSIGHT_VERSION=1.1.0            # 锁版本；官方 git 有 v1.2.x 但 ghcr 未发布对应镜像
   HINDSIGHT_DB_IMAGE=ghcr.io/pglayers/pglayers-full:17   # 见 §1.1 的镜像替换理由
   HINDSIGHT_DB_PASSWORD=<openssl rand -base64 24>
   HINDSIGHT_API_KEY=<client 用的 tenant key>
   HINDSIGHT_CP_ACCESS_KEY=<控制面板登录 key>
   HINDSIGHT_API_LLM_API_KEY=<server 侧 LLM key>
   HINDSIGHT_LLM_BASE_URL=<OpenAI 兼容 endpoint，含 /v1/>
   HINDSIGHT_LLM_MODEL=gpt-6-luna     # retain / consolidation
   HINDSIGHT_REFLECT_LLM_MODEL=gpt-6-luna   # reflect / 知识页刷新，见 §1.2
   HINDSIGHT_LLM_REASONING_EFFORT=low
   HINDSIGHT_DECISION_MODEL_PROVIDER=typesafe
   HINDSIGHT_DECISION_MODEL_BASE_URL=<同上，不含 /v1/>
   HINDSIGHT_DECISION_MODEL_MODEL=jev-1.13
   HINDSIGHT_WORKER_ID=<每实例唯一固定值>
   ```
4. 渲染检查后启动，确认健康：
   ```bash
   cd ~/.config/hindsight-podman
   podman-compose --env-file .env -f compose.yaml config | head -40   # 缺变量在这里报
   podman-compose --env-file .env -f compose.yaml up -d
   curl -fsS http://127.0.0.1:8888/health                            # 期望 healthy + database connected
   ```
5. 对外只给 tailnet：`tailscale serve --bg http://127.0.0.1:8888`、`tailscale serve --bg --https=443 http://127.0.0.1:9999`，`tailscale serve status` 必须是 tailnet only；**绝不用 funnel**。临时替代：`ssh -N -L 18888:127.0.0.1:8888 <server>`。
6. 跑 §4 验收清单，再按 §2 接 client。

### 1.1 本机相对官方必须做的调整（完整清单）

| 位置 | 官方 | 本机 | 原因 |
|---|---|---|---|
| `db.shm_size` | 模板**没有该字段**（= 容器默认 64MB） | `1g`（官方 `docker run` 示例的 `--shm-size=1g`） | 64MB 下 Postgres 并行 worker 扩容共享段失败：`could not resize shared memory segment`，写入静默丢失 |
| `db.image` | `pgvector/pgvector:pg${HINDSIGHT_DB_VERSION:-18}` | `ghcr.io/pglayers/pglayers-full:17`（数据卷路径见下一行） | 该机到 `registry-1.docker.io` 不通（TLS handshake timeout），只能用可达的等价 pgvector 镜像；只要能拉到官方镜像就用官方的 |
| `db.volumes` | pg18 路径 `/var/lib/postgresql/${HINDSIGHT_DB_VERSION}/docker` | `/var/lib/postgresql/data` | 跟随 pg17 镜像的数据目录 |
| `hindsight.ports` | `8888:8888` + `9999:9999`（0.0.0.0） | `127.0.0.1:8888` + `127.0.0.1:9999` | 不对外暴露；UI 另有 `HINDSIGHT_CP_ACCESS_KEY` 登录门 |
| `hindsight.restart` | 无 | `unless-stopped` | 崩溃后自动恢复 |
| `db.healthcheck` | 无 | `pg_isready` + `depends_on: service_healthy` | 让 API 等 DB 就绪，不靠 sleep |
| `LLM_MODEL` | `gpt-5-mini`（默认） | `gpt-6-luna` | 见 §1.2：默认值在本 gateway 上不可用 |
| `LLM_REASONING_EFFORT` | 未设 | `low` | 见 §1.2 |
| `REFLECT_LLM_MODEL` / `MENTAL_MODEL_REFRESH_LLM_MODEL` | 回退 `LLM_MODEL` | `gpt-6-luna` | `gpt-oss-20b` 的 done-tool 会返回空 answer（`Reflect's done tool returned no answer`）；`gpt-6-luna` 无此问题 |
| `REFLECT_LLM_TIMEOUT` | `30` | `120` | reflect 用 luna 后单次调用可达 60–90s（reflect 总时长 median 30s、p90 150s+） |
| `LLM_PROVIDER` | `openai`（默认） | `openai` | 不改；本 gateway 是 OpenAI 兼容 endpoint |
| `LLM_BASE_URL` | 官方默认指向官方云 | `<自建 gateway>` | 本机用内部 endpoint；必须含 `/v1/` 后缀 |
| `REFLECT_MAX_ITERATIONS` | `10` | `6` | 插件默认 `reflectTimeoutMs` 是 20s；本机把两者一起抬高（240s / 6 轮），保持每轮预算不被压缩 |
| `REFLECT_WALL_TIMEOUT` | `300` | `600` | 它同时是"一次完整知识页刷新"的上限，刷新可能跑 85–295s；被砍会暂停该页（§3.3） |
| `REFLECT_DEFAULT_OPTIONS` | 未设 | `{"reflect_search_observations_max_tokens":3000,"reflect_search_observations_include_entities":false}` | 观测检索返回 45KB → 21KB |
| `DECISION_MODEL_*` + `REFLECT_USE_DECISION_MODEL` | `none`（实验特性） | `typesafe` / `jev-1.13` / `true` | endpoint 同时提供 `/v1/systemone`；reflect 由 3 轮降到 1 轮 |
| `MENTAL_MODEL_DELTA_USE_DECISION_MODEL` | 跟随 `REFLECT_USE_DECISION_MODEL` | `true` | 知识页 delta 刷新也走 decision model，与 reflect 保持一致 |
| `RECALL_DECISION_MODEL_PROVIDER` | 跟随全局 | `none` | 否则每次检索都改走 decision model，丢掉 reranker |
| `RERANKER_PROVIDER` | `local` | `flashrank` | 纯 CPU 机器官方推荐 |
| `RERANKER_MAX_CANDIDATES` | `300` | `100` | 官方 Performance 页称 300→100 是纯 CPU 上最大单笔收益；本机 recall 5–6s |
| `ENABLE_BANK_LLM_HEALTH` | `false` | `true` | 仅开启 `POST /health/llm` 端点；代码里没有启动时或定期的自动探测，不调用就不产生 cost。用于在 LLM key 过期前主动发现，见 §3.4 |
| `EMBEDDINGS_PROVIDER` | `local` | `onnx` | 同一 bge-small 模型，不拉 PyTorch |
| `WORKER_ID` | hostname（容器里 = 容器 ID，重启即变） | 每实例唯一固定值 | 官方安装指引推荐 |
| `TENANT_EXTENSION` + `TENANT_API_KEY` | 无（不鉴权） | `ApiKeyTenantExtension` | 每个 client 一把 key |

升级服务端版本时**重新下载官方模板再套用上表**，不要在旧副本上继续改——这是避免长期漂移的唯一办法。

### 1.2 官方文档没写的结论（踩过才知道）

- **`shm_size` 必须手写**：官方 compose 模板没有该字段，照抄即 64MB，故障是静默丢写入而不是报错。
- **推理模型必须钉 `reasoning_effort`**：不设时 reasoning 会吃光 completion 预算，strict-schema 调用返回**空 `content`**（日志 `Provider returned empty message content`），表现为 retain/consolidation 失败、observations 停产、知识页饿死。`gpt-oss-20b` 只接受 `low`（`none`/`minimal` 被上游 Bedrock 拒，`medium` 一次 62s），且即使 `low` 在 consolidation 的多事实批处理上仍会回空 → **它不能用于 consolidation**。当前 retain/consolidation 与 reflect 都用 `gpt-6-luna`（同样钉 `low`），日志里 consolidation 单批 10–25s。
- **reflect 不能用 `gpt-oss-20b`**：它的 done-tool 调用会带空 arguments（`Reflect's done tool returned no answer (iteration N, 3 tool call(s) made): ... finish_reason=tool_calls, argument keys: []`），表现为部分会话在首轮注入时静默降级到 pages。`gpt-6-luna` 无此问题，代价是 reflect 总时长 median 30–80s、p90 可达 150s。
- **客户端 `reflectTimeoutMs` 必须与实测 p90 对齐**：Pi 的 hook 已无超时（`hookTimeout` 已移除，仅 Ctrl+C 中止），所以该值只受服务端 `REFLECT_WALL_TIMEOUT` 约束；当前设 240s 覆盖 p90。
- **`REFLECT_WALL_TIMEOUT` 同时是刷新上限**：默认 300s 会把长刷新砍掉，而一次失败就会让该页暂停自动刷新，直到显式刷新成功（§3.3）。
- **decision model 是实验特性**：开启后 recall 默认也改走它，要用 `RECALL_DECISION_MODEL_PROVIDER=none` 保留 reranker。

## 2. Pi client 接入

在每台 client 的本仓库运行（`--hindsight-api-url` 是唯一 opt-in 开关，脚本不交互）：

```bash
HINDSIGHT_API_TOKEN=<tenant key> ./bootstrap.sh \
  --providers <providers> --default-provider <provider> \
  --hindsight-api-url https://<machine>.<tailnet>.ts.net
```

- URL 必须 HTTPS；HTTP 只允许本机 loopback。token 走 `--hindsight-token-file <file>` 或环境变量，绝不进 argv。
- 脚本调用官方 [coding-agent installer](https://hindsight.vectorize.io/sdks/integrations/coding-agents)，再把 URL/token 写进 `~/.hindsight/coding-agent.json`（`0600`）。client 端不要配 server 的 LLM key。
- 多 client 共享记忆要求 bank/tenant 路由一致，不要假设设备间自动共享。

**client 侧字段（`~/.hindsight/coding-agent.json`，`0600`）**：

| 字段 | 官方默认 | 本机 | 原因 |
|---|---|---|---|
| `autoInject` | `reflect` | `reflect` | 官方默认，首轮注入质量最高；改 `pages`/`recall` 会退回检索或摘要，见 §1.2 |
| `reflectTimeoutMs` | `20000` | `240000` | 必须覆盖实测 p90（luna reflect 中位 30s、p90 可达 150s）；Pi 的 hook 已无超时，该值只受服务端 `REFLECT_WALL_TIMEOUT` 约束 |
| `injectTimeoutMs` | `7000` | 不改 | `pages` / `recall` 是纯检索，实测 0.1–7s |
| `optInOnly` / `optInPaths` | `false` / 空 | `true` / `["~"]` | 见 §2.1 |
| `banks` | — | `coding-agent::caius_kong` 关闭 | home 自身不是项目，见 §2.1 |

改完**重启 Pi** 才生效（persistent plugin 只在加载 workspace 时读配置）。

### 2.1 启用范围：一条 home 前缀 + 按 bank 关停

```jsonc
{
  "optInOnly": true,
  "optInPaths": ["~"],
  "banks": { "coding-agent::caius_kong": { "disabled": true } }
}
```

**前缀只决定“哪些目录被允许”，不改变 bank 粒度**：其下每个 repo 仍各得一个 `coding-agent::{gitProject}` bank，所以只需回答“哪些目录里会有 agent 跑”。官方默认是 `optInOnly: false`（每个项目都有记忆），`["~"]` 是它的严格子集。而逐条列举的两种失效方向不对称：

| 方向 | 漏掉的后果 | 可见性 |
|---|---|---|
| 白名单（opt-in）漏一条 | 那个 repo 从此**不记任何记忆** | 静默，下次用才发现 |
| 黑名单（opt-out）漏一条 | 多出一个 bank | 可见，`GET /v1/default/banks` 就能看到并删 |

所以默认宽启用、用黑名单收口。`/tmp`、`/var/folders`、`/Volumes` 都在 home 之外，天然惰性；`~/Downloads`、`~/Desktop` 只有在里面真跑 agent 时才会建 bank，且建了也只是一个可删的 bank。

**低价值 bank 用 `banks.<bankId>.disabled` 关掉，不要靠收窄 `optInPaths` 去规避。** 本机 home 自身不是项目，但 `cwd=~` 的 session（包括在 home 里起的 agent）会解析出 `coding-agent::caius_kong`；`disabled` 按**已解析的 bank id** 匹配，抑制 session-start（连带抑制 `autoSeed` 与 `codebaseSurvey`）、injection、retain 和记忆工具，且不随目录移动失效。同样的手段适用于：在 home 内跑过一次、事后确认无价值的任何 bank。

**`paths.<prefix>.disabled` 是 opt-in 之后才生效的补充开关**，用于“宽前缀已批准、但这一棵子树要关掉”的场景（例如临时关掉 home 内某个目录）。它不能替代 `optInPaths` 做覆盖管理。

**第三方只读 clone 留在宽前缀里是可以接受的**：它们拿到的是**自己名字的独立 bank**（`coding-agent::{repo}`），不会污染你的项目 bank，代价只是 bank 列表里多一行。真嫌吵就对那个 bank id 加 `disabled`。真正的污染风险在 `mapPathToBank`——它把子目录**写进另一个 bank**，一次问答就进了你的项目记忆，且 hindsight 没有 bank 内的来源过滤手段。**不要用 `mapPathToBank` 把第三方项目并进自己的 bank。**

**不设 `defaultBankConfig`。** 官方用它给新 bank 定统一基线（`enable_observations: false` / `enable_auto_consolidation: false`），但关掉 observations 会让默认 `recallOptions`（`types: ["observation"]`）在新 bank 上**恒为空**，而 observations 正是每 token 信息量最高的那层。且 `pageTriggerType: "cron"` 下刷新是“先判脏再刷”，成本随写入量而非 bank 数增长，冷 bank 几乎零成本——没有省钱的必要。

改完要**重启 Pi** 才生效（persistent plugin 只在加载 workspace 时读配置）。盘点与清理：`GET /v1/default/banks` 列 id，`GET /v1/default/banks/{id}/stats` 看 `total_nodes` / `last_memory_write_at`，删除用 `DELETE /v1/default/banks/{id}`（不可恢复；控制台批量删除是串行执行的，不要并发）。

### 2.2 运行时补丁：探测到才打

**缺陷**：官方运行时在 `before_agent_start` 里直接 `event.prompt.trim()`。Pi 对该事件有两种形态——`messageType:"user"` 带 `prompt`，`messageType:"custom"` 只有 `message`（由扩展在空闲时 `pi.sendMessage(..., {triggerTurn:true})` 触发，本机来自 `pi-subagents` 的异步完成唤醒与 `pi-web-access`）。custom 形态下抛 `Cannot read properties of undefined (reading 'trim')`，该次 run 的记忆注入整体失效。触发方是第三方包对 Pi 公开 API 的正当用法，能修的位置只有消费事件的一方。

`bootstrap.sh` 的 `patch_hindsight_pi_runtime()` 按探测结果决定：

| 探测 | 行为 |
|---|---|
| 已含守卫（`typeof event.prompt === "string"`） | 跳过 |
| 有未守卫的 `event.prompt.trim/slice(` 且锚点命中 | 打补丁，备份 `pi.js.pre-promptguard` |
| 无未守卫使用 | 视为上游已修复，跳过并打印说明 |
| 有使用但锚点已变 | 只告警，不改写 |

`install`/`update` 会覆盖 `dist/`，所以每次装完重跑 bootstrap 即可；上游修复后本步骤自动失效。

### 2.3 可选：多个 repo 共享一个 bank（同一领域）

默认一 repo 一 bank，而 **bank 是 recall 硬边界**（`recall` / `retain` / `reflect` 都在单个 bank 内，没有跨 bank 查询），所以跨 repo 的 agent 看不到别的 repo 的记忆。仅当这些 repo **本来就属于同一领域**（一个平台拆成多个服务、库 + 消费方）时才合并，且**要在积累历史之前做**：事后再合是搬记忆，不是改开关。

**合并只对 cwd 落在收敛 repo 内的会话生效。** bank 由会话的 cwd 解析（`deriveBankId`：`mapPathToBank` → `bankIdTemplate`，`{gitProject}` 取该目录主 worktree 的 basename），且没有任何 `hindsight_*` 工具接受 `bank` 或 `tags`。所以一个从任意目录启动、用绝对路径跨 repo 干活的 agent（本机 `l10n-code-explore` 即此类：定义里无 `cwd` 字段）拿到的是**启动目录**的 bank——合并对它无效，它的读写照旧落在那个 bank。`hindsight_diagnose` 可复现：`~/.pi` → `coding-agent::.pi`，`~/dev/caius-kong/skills` → `coding-agent::skills`，只有落在 7 个 repo 目录内才返回共享 bank。要让这类 agent 也进共享 bank，只能给它一个落在收敛 repo 内的 cwd；配置侧没有替代方案。

这**不是** §2.1 说的那种用法。§2.1 禁止的是把第三方 clone 用 `mapPathToBank` 并进自己的项目 bank（一次问答就污染项目记忆）；这里是把自己拥有的、同一领域的 repo 显式收敛，并且每个 repo 仍保留独立的观测作用域。

**机制二选一**

| 机制 | 适用 | 代价 |
|---|---|---|
| `banks.<resolvedId>.bank` | 手挑的一组 repo | repo 搬家不受影响；目标 bank 自己的 section 不会被读取 |
| `mapPathToBank` | 目录即边界，或 repo 不是 git 仓库 | repo 移动后映射失效 |

`bank` 是**改名不是合并**：改名前的 id 不会发到 API，不复制任何数据，旧 bank 也不会被删除，只是再没有会话能解析到它——所以必须按下面第 3 步搬。

**配置**（每个收敛项都要重复，因为目标 bank 的 section 不生效）

```jsonc
"banks": {
  "coding-agent::repo-a": {
    "bank": "coding-agent::shared",
    "retainTags": ["project:{gitProject}"],
    "observationScopes": [[], ["project:repo-a"]]
  },
  "coding-agent::repo-b": {
    "bank": "coding-agent::shared",
    "retainTags": ["project:{gitProject}"],
    "observationScopes": [[], ["project:repo-b"]]
  }
}
```

- **空 scope 不能省。** `[[], ["project:<repo>"]]` 既给每个 repo 独立信念集，又保留页面读取的无 tag 全域层。写成只有非空项（如 `[["project:*"]]`）在写入都带 `project:` tag 时隔离效果一样，但页面会退化成只读原始事实——这层是页面拿到 consolidated 观测的唯一入口（`tags_match: "all"` 会带过 untagged，带 `project:` 的观测对页面不可见）。去掉它，页面只剩显式带 `knowledge:*` tag 的原始事实——实测：`[["project:*"]]` 的 bank 里同一份内容，普通 recall 能取到该观测，页面的过滤器返回 0。`per_source` 用的也是同一个 `[[], …]` 形状。代价是每份文档多跑一遍 consolidation（两个 scope 各一次）；`project:<repo>` 这层目前的读取方是用 `customPages` + `tags` 做的 per-repo 页面，普通 recall 不按 scope 过滤。
- **优先字面值而非 glob**：每个 section 只覆盖一个 repo，字面值不依赖服务端 tag 匹配，也不依赖 1.1+ 的 glob 语义。glob 另有一处回退：写入不带 `project:` tag 时 glob 匹配不到任何 tag，服务端回落到 `combined`（按 tag 集合分组），而 `(source:chat, harness:pi)` 这类集合跨 repo 完全相同——跨 repo 汇聚会从后门回来。实测：`[["project:*"]]` 且无 `retainTags` 的写入落到 scope `["harness:pi", "source:upload"]`。
- `coding-agent.json` 是 `JSON.parse`：一个 `//` 注释会让**整份配置**被丢弃并回落到默认值（只在 stderr 留一行，症状是记忆突然变安静）。
- **`project:<repo>` 必须等于 `{gitProject}` 的实际值**（目录或主 worktree 的 basename，大小写敏感）。字面 scope 不依赖 tag，两者不一致时观测照旧分区、不会报错；但记忆上的 `project:` tag 会与 scope 各说各话，将来按 tag 建的 per-repo 页面取不到东西。改目录名前先核对这一项。

**顺序：先冻结、再改配置、再搬**

1. **冻结。** 运行中的 Pi 进程按 cwd 缓存了 runtime 与 bank，改配置**不会**重定向它们；在跑的 `deepen.js` 也在启动时快照配置。先退出这些 repo 里的 session，并确认旧 bank `pending_operations: 0`。
2. **改配置并验证解析。** 每个 repo 里跑一次 `hindsight_diagnose`，`bank_id` 必须都是目标 bank。key 写错是**静默失效**（那个 repo 继续用自己的 bank）；改目录名或 `bankIdTemplate` 同样静默失效，必须重跑这一步。
3. **搬不可再生的内容**：会话记录、手工 ingest 的文档、survey 产物。跳过 `gitlog:*`（共享 bank 会按 repo 重新 seed，且 per-repo id 会撞）与 `survey-baseline:*`（内部标记，无抽取内容）。四个必踩的机制：

| 机制 | 说明 |
|---|---|
| 导出子集 | 必须带 `include_bank_config=false`，否则 `400` |
| `download_url` | `result_metadata.download_url` 是**相对路径**，要拼 `apiUrl` |
| 导入 body | 必须 `multipart/form-data` + 必填 `file` 字段；裸 `application/zip` 返回 `422` |
| 目标 bank | `mode=merge` 到不存在的目标会自动创建，不需要预热会话 |

迁入的事实保留原来的 `shared` scope，会落进无 tag 全域池；要按 repo 隔离得逐文档 `PATCH`（只重建 scope 真正变动的记忆）：

```http
PATCH /v1/default/banks/coding-agent::shared/documents/<doc_id>
{"observation_scopes": [[], ["project:repo-a"]]}
```

**共享 bank 特有的坑**

| 坑 | 说明 |
|---|---|
| `repository-*` 是全局槽位 | 其 document id 不带 repo（`repository-component-map` 在每个 repo 都是同一个 id），一个 bank 里最后写的赢，导入时其余被 `skip`。落选的要用 repo 作用域 id 重新 ingest，再删旧 bank |
| `gitlog:<Repo>` 安全 | id 带 repo，多个 repo 各一份，共存不冲突 |
| cold 判定是 bank 级 | 第一个 repo seed 完，其余就不再算 cold；`codebaseSurvey` 整个 bank 最多跑一次，而 pi 下根本不会跑（§2.2 同理，`resolveAgentBin` 无 pi 分支） |
| 页面变家族级 | 改名后没有单一 `project`，页面 scope 子句变成"本 bank 由多个项目共享"；要 per-repo 页面得用 `customPages` + `tags`，代价是每页每次刷新一次合成 |
| 无 per-call 过滤 | 没有 `hindsight_*` 工具接受 `bank` 或 `tags`，会话内无法把召回收窄到某个 repo。跨 repo 召回本就是目的，但不要向使用者承诺精度 |
| `DELETE` 不可恢复 | 连同文档、事实、观测一起删；确认迁移后再执行 |

**验收**：`GET /v1/default/banks/<shared>/observations/scopes` 必须同时有**空 tag 列表**和每个有数据的 repo 的 `["project:<repo>"]`（缺空项就是页面在退化）；`stats` 的 `pending_operations` 归零后再看计数；每个 repo 开一次会话生成它自己的 `gitlog:<Repo>`，读一个页面确认非空；`diag.jsonl` 里那次会话应出现 `session_start`（共享 bank）+ `inject_ok` + `retain_ok`，即召回与回写都落在共享 bank。

## 3. 迁移 / 备份 / 升级

| 目的 | 路线 |
|---|---|
| 升级 `HINDSIGHT_VERSION`、换机器搬**整个实例** | §3.1 `pg_dump`/`pg_restore`（含 embedding；两端数据库大版本必须一致） |
| 把**某个 bank**搬到另一实例（版本/embedding 可不同） | §3.2 `export-bank`/`import-bank`（导出不含 embedding，导入端重算；不调 LLM） |

### 3.1 整库备份 / 搬实例 / 升级

```bash
# 备份（服务运行中即可）
podman exec hindsight-db pg_dump -U hindsight_user -d hindsight_db -Fc -f /tmp/hs.dump
podman cp hindsight-db:/tmp/hs.dump ~/hindsight-backup-$(date +%Y%m%d-%H%M).dump
podman exec hindsight-db rm -f /tmp/hs.dump

# 升级：改 .env 的 HINDSIGHT_VERSION → 重建 app（DB 容器与数据卷不动）
podman-compose --env-file .env -f compose.yaml up -d
podman logs --since 5m hindsight-app | grep -iE "migration|error|Traceback"   # 期望 Schema migrations completed

# 换实例：新机器起空库后恢复
podman cp ~/hindsight-backup-XXXX.dump hindsight-db:/tmp/hs.dump
podman exec hindsight-db pg_restore -U hindsight_user -d hindsight_db --no-owner --no-privileges /tmp/hs.dump
```

回滚：`HINDSIGHT_VERSION` 改回旧值 `up -d`；schema 已不兼容时从备份恢复。

### 3.2 搬单个 bank

官方 [Memory Banks · bank transfer](https://hindsight.vectorize.io/developer/api/memory-banks) · [Admin CLI](https://hindsight.vectorize.io/developer/admin-cli#export-bank)。`hindsight-admin` 直连 PostgreSQL，须在 API 同一环境跑（`podman exec -it hindsight-app hindsight-admin ...`）：

```bash
hindsight-admin export-bank --bank <BANK_ID> --output <BANK_ID>.zip   # 旧实例
hindsight-admin import-bank --archive <BANK_ID>.zip                    # 新实例：目标 bank 必须不存在
hindsight-admin repair-bank --all                                      # 升级/换 vector 后端后补 per-bank 索引
```

这是整库搬家不是 merge；先盘点目标端可丢弃的数据。只需配置/页面/directive 时用 HTTP `GET|POST /v1/default/banks/{bank_id}/export|import`（支持 `dry_run=true`）。

### 3.3 知识页停止刷新的排查与恢复

**机制**：刷新失败（含被 `REFLECT_WALL_TIMEOUT` 砍掉、delta 编辑没应用）重试到 `WORKER_MAX_RETRIES` 后放弃并写 `last_refresh_failed_at`；**该字段存在期间，页不再按任何自动触发刷新**。日志表现为 `scheduled 0 model(s), N up-to-date, M paused after a failed refresh`。

```bash
curl -H "Authorization: Bearer $KEY" .../v1/default/banks/<bank>/mental-models/<id>/history | jq '.[0]'
# kind=refresh_failed, outcome=refresh_failed_delta_not_applied / refresh_failed_error / ...
```

先修根因（模型、并发、wall timeout），再**逐页显式刷新**一次即可清除标记并恢复自动刷新；delta 反复失败就把该页改成 full：

```bash
curl -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"trigger":{"mode":"full"}}' .../v1/default/banks/<bank>/mental-models/<id>
curl -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"updates":{"knowledge_page_default_trigger":{"mode":"full"}}}' .../v1/default/banks/<bank>/config
curl -X POST -H "Authorization: Bearer $KEY" .../v1/default/banks/<bank>/mental-models/<id>/refresh
```

一次推太多会互抢 LLM 并发而集体超时；串行刷新最稳。

### 3.4 LLM key 过期：静默失效，必须主动探测

**症状**：`retain` / `consolidation` / `reflect` / 知识页刷新全部失败，但 `recall` / `pages` / `search` 仍正常（不走 LLM）。客户端在 reflect 失败时会静默回退到 pages，所以用户看到的现象只有“记忆不再增长”，**没有任何报错**。

**提前知道**：key 若是 JWT，直接解 payload 拿 `exp`：

```bash
python3 -c "import base64,json,sys,datetime;t=sys.argv[1].split('.')[1];t+='='*(-len(t)%4);d=json.loads(base64.urlsafe_b64decode(t));print(datetime.datetime.fromtimestamp(d['exp']))" "$HINDSIGHT_API_LLM_API_KEY"
```

**主动探测**（需要 §1.1 的 `ENABLE_BANK_LLM_HEALTH=true`）：

```bash
curl -sX POST -H "Authorization: Bearer $TENANT_KEY" -H 'Content-Type: application/json' -d '{}' \
  https://<host>/v1/default/banks/<bank>/health/llm
# → {"operations":[{"operation":"retain","ok":true,"status":"connected",...}, ...]}
```

它会对该 bank 用到的每个**不同** LLM 配置各发一次最小调用（共用同一模型的操作只探一次），所以一次探测约 1s、几个 token。官方明确 “not for polling”——不要设成 cron 轮询，在换 key 前后、或到期前手动跑一次。

**换 key**：改 `.env` 的 `HINDSIGHT_API_LLM_API_KEY` 后必须 `podman-compose up -d` 重建容器，**只改 env 不重建不生效**。换完跑一次上面的探测，再查 `GET /v1/default/banks/<bank>/operations?status=failed` 是否归零。

### 3.5 502 抖动 / 容器反复重启：先查 OOM

**症状**：客户端 `/health` 与 `recall` 间歇 502、重试能过，而 `retain` 和 `DELETE` 仍成功。应用日志里找不到对应的 5xx——请求根本没到达应用。

**判据**（三条一起看）：

```bash
podman inspect hindsight-app --format '{{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
podman events --stream=false --since 24h --filter event=died --format '{{.Time}} {{.Name}}' | wc -l
podman machine ssh free -m          # 看 available 与 Swap 行
```

`oom=true` 或 `restarts` 持续增长就是内核 OOM kill：容器 exit code 0、日志无 traceback，因为被 SIGKILL 的是进程本身。VM 无 swap，余量不足时内核挑最大的进程杀，通常正是 API。注意 `oom` 标志会保留上一次实例的死因，所以要与 `restarts` 和“最近是否有新的 died 事件”一起读。

**处置**：抬高 VM 内存，宿主机不够就换机器——Podman 的 applehv VM 不提供 swap 配置，加 swap 不是选项。

```bash
podman machine stop hindsight
podman machine set --memory 8192 hindsight
podman machine start hindsight
podman ps                       # restart=unless-stopped 的容器应已自动拉起；没有则 podman-compose up -d
```

`start` 报 `unable to connect to "gvproxy" socket` 时机器会显示 running，但 podman socket 拒连（`podman ps` → `connection refused`，`podman machine ssh` → `vm is not running`）。再执行一次 `podman machine stop` + `start` 即恢复；数据卷在 VM 磁盘内，不随 machine 重启丢失。

## 4. 验收清单

- [ ] `/health` healthy 且 database connected；API/UI 只监听 loopback，无 host 端口外泄。
- [ ] 无 key / 错 key 为 `401`，有效 key 为 `200`；`tailscale serve status` 显示 tailnet only，funnel 未启用。
- [ ] `podman inspect hindsight-db --format '{{.HostConfig.ShmSize}}'` = `1073741824`。
- [ ] 连续 retain 无 `could not resize shared memory segment`、无 `Provider returned empty message content`。
- [ ] 一次真实 retain + recall 正常（recall ≤ 7s）；一次 `hindsight_reflect` 返回非空 `text` 且耗时 ≤ `reflectTimeoutMs`。
- [ ] `reflect` 连续 5 次无 `Reflect's done tool returned no answer`。
- [ ] `podman inspect hindsight-app --format '{{.State.OOMKilled}} {{.RestartCount}}'` 为 `false` 且 restarts 不增长；`podman machine ssh free -m` 的 available ≥ 1.5 GB（§3.5）。
- [ ] 调度日志无 `paused after a failed refresh`；各页 `last_refresh_failed_at` 为空。
- [ ] 容器 env 里 `HINDSIGHT_API_LLM_MODEL` / `HINDSIGHT_API_REFLECT_LLM_MODEL` / `HINDSIGHT_API_RERANKER_MAX_CANDIDATES` / `HINDSIGHT_VERSION` 与 §1.1 一致。
- [ ] client `hindsight_diagnose` 通过；`coding-agent.json` 为 `0600`，`reflectTimeoutMs` 与实测 p90 对齐。
- [ ] `optInOnly: true` 且 `optInPaths: ["~"]`，home 自身 bank 已 `disabled`（§2.1）；`/tmp` 下启动 agent 不产生新 bank，而 `/tmp` 下 home repo 的 linked worktree 落到 main repo 的 bank。
- [ ] 若启用了共享 bank（§2.3）：每个收敛 repo 的 `hindsight_diagnose` 都指向同一 bank id；`observations/scopes` 同时含空 tag 列表与各 repo 的 `project:<repo>` 作用域；旧 bank 的不可再生内容已迁入或已明确放弃。
- [ ] LLM key 的 `exp` 已记录并在到期前安排轮换；`POST /health/llm` 三个 operation 均 `connected`。
- [ ] 重启（VM + 主机）后 API 自动恢复；secret 未进 Git/日志/命令行。

## 参考

- Installation — https://hindsight.vectorize.io/developer/installation
- Configuration（全部环境变量与默认值）— https://hindsight.vectorize.io/developer/configuration
- Reflect / decision model / 知识页 API — https://hindsight.vectorize.io/developer/reflect · https://hindsight.vectorize.io/developer/api/knowledge-pages
- external-pg compose 模板 — https://github.com/vectorize-io/hindsight/blob/main/docker/docker-compose/external-pg/docker-compose.yaml
- Coding-agent 集成 — https://hindsight.vectorize.io/sdks/integrations/coding-agents
- Tailscale Serve — https://tailscale.com/kb/1242/tailscale-serve · Podman macOS autostart — https://github.com/containers/podman/blob/main/docs/tutorials/macos_autostart.md
