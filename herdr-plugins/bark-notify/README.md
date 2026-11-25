# herdr-bark

把 Herdr 的 agent 状态变化推到 Bark（iOS）。     466 行，纯 Python 标准库，零第三方依赖。

只用两个官方接口：Herdr 的 plugin event hook（`herdr-plugin.toml` 的 `[[events]]`）和 Bark 的 GET 推送接口。

## 触发范围

| 事件 | 推送 | 说明 |
|---|---|---|
| `agent_status` → `blocked` | 「<agent> 需要你」 | 延迟 `BARK_BLOCKED_DELAY` 秒后重读实时状态，agent 自己批准掉的不推 |
| `agent_status` → `done` | 「<agent> 已完成」 | 未被查看的 pane 完成 |
| `working`/`blocked` → `idle` | 「<agent> 已完成」 | 正在查看的 pane 完成 |
| `done` → `idle` | 不推 | 同一次完成不重复 |
| `working` | 不推 | 只记开始时间，用来算耗时 |
| `agent_status` → `unknown` | 「<agent> 状态丢失」 | 仅当上一状态是 working/blocked |
| `pane.exited` / `pane.closed` | 「<agent> 已退出」 | |

推送内容形如（正文三行：位置 · 目标 · 最后回复）：

```
标题：pi 已完成
正文：t3code · main (2m05s)
      目标：把 herdr-bark 的免打扰改成工作日 9-12、14-18
      已完成，提交在 cf952d25，README 也同步更新了。
```

## 正文内容

正文最多三行，每行独立可关：

| 行 | 来源 | 关闭方式 |
|---|---|---|
| 位置 | Herdr 里重命名的工作区标签 · 仓库 · 分支（· 耗时） | — |
| 目标 | session 里最后一条 `agent-goal-state` 的 `goal`，没设 goal 时退到 `lastPrompt` | `BARK_GOAL_CHARS=0` |
| 最后回复 | session 里最后一条 assistant 消息的文本 | `BARK_REPLY_CHARS=0` |

两个 `_CHARS` 同时是截断长度。文本里的 Markdown 链接只留标题、`**` 和反引号去掉，所以手机上不会看到一串 URL。

能取到哪些取决于 agent 是否向 Herdr 上报 session 文件（`agent_session.value`）。pi 会上报，codex 不报——codex 的推送只剩位置行，但它的工作区标签本身就是任务描述。

## 安装

```bash
herdr plugin link ~/.pi/herdr-plugins/bark-notify
herdr plugin action invoke caius.bark-notify.status
herdr plugin action invoke caius.bark-notify.test
herdr plugin log list --plugin caius.bark-notify
```

`link` 立即注册并开始跑 hook，不需要重启 server。卸载：`herdr plugin unlink caius.bark-notify`。

## 配置

配置**只有一个位置**：`~/.pi/herdr-plugins/bark-notify/.env`（gitignore 掉，mode 600）。从 `.env.example` 复制起步。

没有回退链：不读 `~/.env`，也不读 Herdr 的插件配置目录。`BARK_KEY` 只存一份，避免密钥在多处各存一份而无人察觉。进程环境变量仍可覆盖（用于一次性测试），那是运行时值，不是存储位置。

`herdr plugin action invoke caius.bark-notify.status` 打印配置文件路径、key 是否存在、当前是否处于免打扰。

### 免打扰时段

在电脑前的时段不必推手机——那时候看屏幕就行。

```bash
BARK_QUIET_ENABLE=true                         # 总开关，false 时忽略下面所有设置
BARK_QUIET_TZ=Asia/Shanghai
BARK_QUIET_DAYS=mon-fri                        # 也支持 mon,tue,wed / sat-sun / fri-mon
BARK_QUIET_HOURS=09:00-12:00,14:00-18:00       # 逗号分隔多段，支持跨天如 22:00-06:00
BARK_QUIET_EXEMPT=                             # 免打扰期间仍然推送的类型，如 blocked
```

区间左闭右开：`09:00` 开始静音，`12:00` 恢复。默认工作日 9-12、14-18 静音，其余时间照常推。

`BARK_QUIET_ENABLE=false` 临时关掉整套免打扰而不删时段，适合假期或出差。

`BARK_QUIET_EXEMPT=blocked` 值得考虑：免打扰的假设是「我在电脑前」，但偶尔会临时离开。开了之后审批请求仍会在工作日打扰，其余类型静音。

### 全部配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `BARK_KEY` | 必填 | Bark app 首页的 device key |
| `BARK_SERVER` | `https://api.day.app` | 自建 bark-server 改这里 |
| `BARK_GROUP` | `herdr` | 通知分组 |
| `BARK_LEVEL` | 空 | `active` / `timeSensitive` / `passive`；`timeSensitive` 可穿透专注模式 |
| `BARK_SOUND` | 空 | 如 `alarm` |
| `BARK_BLOCKED_DELAY` | `3` | blocked 后重查延迟秒数，`0` 关闭 |
| `BARK_REPLY_CHARS` | `200` | 最后回复的截断长度，`0` 不推这一行 |
| `BARK_GOAL_CHARS` | `120` | 目标行的截断长度，`0` 不推这一行 |
| `BARK_QUIET_ENABLE` | `true` | 免打扰总开关 |
| `BARK_QUIET_TZ` | 系统时区 | 免打扰判断用的时区 |
| `BARK_QUIET_DAYS` | 空（每天） | 免打扰生效的星期 |
| `BARK_QUIET_HOURS` | 空（不静音） | 免打扰时段 |
| `BARK_QUIET_EXEMPT` | 空 | 免打扰期间仍然推送的类型 |

## 实现要点

**完成状态有两种。** Herdr 只在完成「未被查看」时报 `done`；正在看那个 pane 时，同一个事件以 `idle` 到达。只匹配 `done` 会静默丢弃这类完成，所以按 pane 记住上一状态，把 `working|blocked -> idle` 也判定为完成。

**事件里没有任务信息。** payload 的 `title` 只在有东西调用 `herdr pane report-metadata` 时才出现，agent 默认不填。所以通过 `herdr agent list` 回查该 pane，取 agent 类型、终端标题与 cwd，再用 `git rev-parse` 补分支。

**`focused_pane_cwd` 不能直接用。** 它只在 `focused_pane_id` 等于事件 pane 时才可信；盯着 A pane 而 B pane 完成时，用它会报出 A 的目录。这里一律用 `herdr agent list` 回查事件 pane 自己的 `foreground_cwd`。

**位置行用工作区标签，不用目录名。** 多个工作区可以共用一个 cwd（每个 `~/.pi` 会话都显示 `.pi`），只有重命名过的标签能区分它们。标签取自事件的 `workspace_label`；取不到时回查 `herdr workspace get`。tab 标签只有在不是纯数字且不同于工作区标签时才追加，因为默认的 `1` 没有信息量。

**blocked 常是瞬态。** 自批准型 agent 会短暂经过这个状态，所以延迟后重读一次实时状态，已经继续执行就不推。

**回复和目标是读 transcript，不是抓屏。** agent TUI 的最后几行永远是输入框和状态栏，抓屏拿不到回复。Herdr 在 `agent list` 里给出 `agent_session.value`（session 文件的绝对路径），所以直接读该 JSONL 末尾 256 KB，从后往前取最后一条 assistant 消息和最后一条 `agent-goal-state`。首行可能是截断的半行 JSON，解析失败就跳过。

## 尚未实现

- `cooldown` 同 pane 同类去重
- `min_turn_seconds` 过滤过短的 turn
- workspace/tab/agent 的 include/exclude 通配过滤
- 推送失败重试与重投队列（现在只写 stderr，不影响 Herdr）
- 双向回复（Bark 只支持单向推送）

## 验证

```bash
HERDR_PLUGIN_STATE_DIR=/tmp/y \
HERDR_PLUGIN_EVENT_JSON='{"data":{"type":"pane_agent_status_changed","pane_id":"w1:p1","agent_status":"idle"}}' \
python3 notify.py --dry-run
```

`--dry-run` 打印将要请求的 URL（key 已脱敏）。`--force` 绕过免打扰，用于手动验证。

## 安全边界

- 只读 `HERDR_PLUGIN_EVENT_JSON` / `HERDR_PLUGIN_CONTEXT_JSON` / `herdr agent list` / agent 自己的 session 文件，写一个 `state.json`
- 唯一外部调用是 Bark 服务器，超时 10 秒；失败只写 stderr
- 密钥只从本目录 `.env` 读，不写进日志，也不进 git（`.gitignore` + mode 600）
