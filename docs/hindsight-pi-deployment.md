# Hindsight server SOP：部署 → 接入 Pi → 运维

给 LLM 执行用。读完应能独立完成：① 按官方指南部署一台 Hindsight server；② 可选地把旧实例数据迁过来；③ 把 Pi client 接上。

## 0. 原则

- **部署以官方文档为准**，采用官方 external-pg `docker-compose` 方式。本仓库**不复制、不维护**官方 compose 副本：需要时现下载，只按 §1.1 改。
- 本文只写四类内容：与官方的差异（含原因）、官方文档没写的踩坑结论、可执行步骤、验收与排障。历史叙述留给提交信息。
- 锁版本（不用 `latest`）；secrets 只写 server 的 `.env`（`0600`）；API/UI 只绑 loopback；永不用 `compose down -v`。

## 1. 部署

官方：[Installation](https://hindsight.vectorize.io/developer/installation) · [Configuration](https://hindsight.vectorize.io/developer/configuration) · [external-pg compose](https://github.com/vectorize-io/hindsight/blob/main/docker/docker-compose/external-pg/docker-compose.yaml)。Quick Start 的 `docker run` + 内嵌 pg0 只适合试跑。

1. 资源：给容器 ≥4 vCPU / ≥6 GB（full 镜像加载本地 embedding + reranker）。macOS 用 Podman：`podman machine init --cpus 4 --memory 6144 hindsight && podman machine start hindsight`（登录后自启见 [Podman macOS autostart](https://github.com/containers/podman/blob/main/docs/tutorials/macos_autostart.md)）。
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
| `REFLECT_LLM_MODEL` / `MENTAL_MODEL_REFRESH_LLM_MODEL` | 回退 `LLM_MODEL` | `gpt-6-luna` | `gpt-oss-20b` 的 done-tool 会返回空 answer（实测 8 次中 3 次 `Reflect's done tool returned no answer`，成功率 62.5%）；`gpt-6-luna` 实测 10/10 成功 |
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
| `RERANKER_MAX_CANDIDATES` | `300` | `100` | 官方 Performance 页称 300→100 是纯 CPU 上最大单笔收益；实测 recall 18.5s→5-6s |
| `ENABLE_BANK_LLM_HEALTH` | `false` | `true` | 仅开启 `POST /health/llm` 端点；代码里没有启动时或定期的自动探测，不调用就不产生 cost。用于在 LLM key 过期前主动发现，见 §3.4 |
| `EMBEDDINGS_PROVIDER` | `local` | `onnx` | 同一 bge-small 模型，不拉 PyTorch |
| `WORKER_ID` | hostname（容器里 = 容器 ID，重启即变） | 每实例唯一固定值 | 官方安装指引推荐 |
| `TENANT_EXTENSION` + `TENANT_API_KEY` | 无（不鉴权） | `ApiKeyTenantExtension` | 每个 client 一把 key |

升级服务端版本时**重新下载官方模板再套用上表**，不要在旧副本上继续改——这是避免长期漂移的唯一办法。

### 1.2 官方文档没写的结论（踩过才知道）

- **`shm_size` 必须手写**：官方 compose 模板没有该字段，照抄即 64MB，故障是静默丢写入而不是报错。
- **推理模型必须钉 `reasoning_effort`**：不设时 reasoning 会吃光 completion 预算，strict-schema 调用返回**空 `content`**（日志 `Provider returned empty message content`），表现为 retain/consolidation 失败、observations 停产、知识页饿死。`gpt-oss-20b` 只接受 `low`（`none`/`minimal` 被上游 Bedrock 拒，`medium` 一次 62s），且即使 `low` 在 consolidation 的多事实批处理上仍会回空 → **它不能用于 consolidation**。当前 retain/consolidation 与 reflect 都用 `gpt-6-luna`（同样钉 `low`），日志里 consolidation 单批 10–25s。
- **reflect 不能用 `gpt-oss-20b`**：它的 done-tool 调用会带空 arguments（`Reflect's done tool returned no answer (iteration N, 3 tool call(s) made): ... finish_reason=tool_calls, argument keys: []`），实测成功率仅 62.5%，表现为约 1/3 的会话在首轮注入时静默降级到 pages。换成 `gpt-6-luna` 后 10/10 成功，代价是 reflect 总时长从 median 63s 升到 median 30–80s、p90 可达 150s。
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
| `optInOnly` / `optInPaths` | `false` / 空 | `true` / 白名单 | 见 §2.1 |

改完**重启 Pi** 才生效（persistent plugin 只在加载 workspace 时读配置）。

### 2.1 bank 白名单（必做，必须按本机环境定制）

**不开白名单就会污染 bank 列表**：默认每个工作目录都开一个 bank，`/tmp` 跑一次 e2e、`~/Downloads` 解个包、随手 clone 的临时仓库都会留下一个永久的空 bank。这类垃圾 bank 无法用名字区分，清理时要逐个看 `total_nodes` 才能判断能不能删。

```jsonc
{
  "optInOnly": true,
  "optInPaths": ["<你真正会跑 agent 的根目录>", ...]
}
```

`optInOnly: true` 表示**只有列出的路径前缀下的项目才创建 bank，其余目录完全惰性**（不连服务端、不写入）。`optInPaths` 是前缀匹配，其下每个 repo 仍各有自己的 bank。

**这份列表取决于本机环境，没有通用答案。** 填之前先想清楚：哪些目录里你真的会启动 agent 并希望它记住上下文？典型的候选是配置文件仓库、自有 skill/代码仓库的父目录；典型的不该加入：`/tmp`、`~/Downloads`、`~/Desktop`、只读参考用的第三方 clone。

**`mapPathToBank` 慎用。** 它把子目录强制写进另一个 bank，适合“monorepo 里的子包属于父项目”这类场景。不要用它把**第三方只读项目**映射进自己的项目 bank：那个目录里的一次问答会被写进你的项目记忆，以后 recall 会召回别人的代码细节，且 hindsight 没有 bank 内的来源过滤手段。宁可给它一个独立 bank，或者干脆不 opt-in。

改完要**重启 Pi** 才生效（persistent plugin 只在加载 workspace 时读配置）。清理已有垃圾 bank：先看 `GET /v1/default/banks/{id}/stats` 的 `total_nodes`，再 `DELETE /v1/default/banks/{id}`。

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

## 4. 验收清单

- [ ] `/health` healthy 且 database connected；API/UI 只监听 loopback，无 host 端口外泄。
- [ ] 无 key / 错 key 为 `401`，有效 key 为 `200`；`tailscale serve status` 显示 tailnet only，funnel 未启用。
- [ ] `podman inspect hindsight-db --format '{{.HostConfig.ShmSize}}'` = `1073741824`。
- [ ] 连续 retain 无 `could not resize shared memory segment`、无 `Provider returned empty message content`。
- [ ] 一次真实 retain + recall 正常（recall ≤ 7s）；一次 `hindsight_reflect` 返回非空 `text` 且耗时 ≤ `reflectTimeoutMs`。
- [ ] `reflect` 连续 5 次无 `Reflect's done tool returned no answer`（用 `gpt-oss-20b` 时实测约 1/3 会命中）。
- [ ] 调度日志无 `paused after a failed refresh`；各页 `last_refresh_failed_at` 为空。
- [ ] 容器 env 里 `HINDSIGHT_API_LLM_MODEL` / `HINDSIGHT_API_REFLECT_LLM_MODEL` / `HINDSIGHT_API_RERANKER_MAX_CANDIDATES` / `HINDSIGHT_VERSION` 与 §1.1 一致。
- [ ] client `hindsight_diagnose` 通过；`coding-agent.json` 为 `0600`，`reflectTimeoutMs` 与实测 p90 对齐。
- [ ] `optInOnly: true` 且 `optInPaths` 已按本机环境定制（§2.1）；`/tmp` 下启动 agent 不产生新 bank。
- [ ] LLM key 的 `exp` 已记录并在到期前安排轮换；`POST /health/llm` 三个 operation 均 `connected`。
- [ ] 重启（VM + 主机）后 API 自动恢复；secret 未进 Git/日志/命令行。

## 参考

- Installation — https://hindsight.vectorize.io/developer/installation
- Configuration（全部环境变量与默认值）— https://hindsight.vectorize.io/developer/configuration
- Reflect / decision model / 知识页 API — https://hindsight.vectorize.io/developer/reflect · https://hindsight.vectorize.io/developer/api/knowledge-pages
- external-pg compose 模板 — https://github.com/vectorize-io/hindsight/blob/main/docker/docker-compose/external-pg/docker-compose.yaml
- Coding-agent 集成 — https://hindsight.vectorize.io/sdks/integrations/coding-agents
- Tailscale Serve — https://tailscale.com/kb/1242/tailscale-serve · Podman macOS autostart — https://github.com/containers/podman/blob/main/docs/tutorials/macos_autostart.md
