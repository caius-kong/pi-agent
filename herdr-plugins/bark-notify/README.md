# herdr-bark

把 Herdr 的 agent 状态变化推到 Bark（iOS）。**257 行，纯 Python 标准库，零第三方依赖。**

只用 Herdr 官方的 plugin event hook（`herdr-plugin.toml` 的 `[[events]]`）和 Bark 官方的 GET 推送接口。

## 为什么不用现成插件

`zgxme/herdr-webhook-notify` 质量不差（CI、70 个测试、SECURITY.md），但它是 11 个渠道的通用转发器：为了发一条 Bark 推送，要跑 13 个 provider 实现 + i18n + vendored tomli + 重试队列。Herdr 官方明确 plugin 以用户权限运行且 **Herdr 不审查代码**（[docs/plugins](https://herdr.dev/tui/docs/plugins/)）——stars 不是安全指标，行数是。

| | zgxme 插件 | 本插件 |
|---|---|---|
| 行数 | ~2000（含 13 个 provider） | 257 |
| 依赖 | Python 3.9+，vendored tomli | 标准库 |
| 渠道 | 11 个，无 Bark | Bark |
| 覆盖的两个坑 | ✅ | ✅ |

## 覆盖了什么

`zgxme` 的 README 点出「自己写 hook 会踩的两个坑」，本插件都覆盖：

**坑 1：正盯着 pane 时完成会漏报。** Herdr 只在完成「未被查看」时报 `done`；你正看着那个 pane 时，同一个事件以 `idle` 到达。只匹配 `done` 的 hook 会静默丢弃。
→ 本插件按 pane 记住上一个状态，把 `working|blocked -> idle` 也判定为完成。

**坑 2：事件里没有任务信息。** payload 的 `title` 只在有东西调用 `herdr pane report-metadata` 时才出现，agent 默认不填。
→ 本插件通过 `herdr agent list` 回查该 pane，补上 agent 类型、终端标题、cwd，再用 `git rev-parse` 补分支。

实测推送内容：

```
标题：pi 已完成
正文：π - xbox - .pi · pi-config · main (2m05s)
```

### 一个容易写错的地方

`HERDR_PLUGIN_CONTEXT_JSON` 里的 `focused_pane_cwd` **只在 `focused_pane_id` 等于事件 pane 时才可信**。你盯着 A pane 而 B pane 完成时，直接用 `focused_pane_cwd` 会把 A 的目录报给 B 的通知。本插件不用它，改用 `herdr agent list` 回查事件 pane 自己的 `foreground_cwd`。

## 触发范围

| 事件 | 推送 | 说明 |
|---|---|---|
| `agent_status` → `blocked` | 「<agent> 需要你」 | 延迟 `BARK_BLOCKED_DELAY` 秒后重读实时状态，agent 自己批准掉的不推 |
| `agent_status` → `done` | 「<agent> 已完成」 | 你没在看的 pane 完成 |
| `working`/`blocked` → `idle` | 「<agent> 已完成」 | 你在看的 pane 完成（坑 1） |
| `done` → `idle` | 不推 | 同一次完成不重复 |
| `working` | 不推 | 只记开始时间，用来算耗时 |
| `agent_status` → `unknown` | 「<agent> 状态丢失」 | 仅当上一状态是 working/blocked |
| `pane.exited` / `pane.closed` | 「<agent> 已退出」 | |

## 安装

```bash
herdr plugin link ~/.pi/herdr-plugins/bark-notify
herdr plugin action invoke caius.bark-notify.status
herdr plugin action invoke caius.bark-notify.test
herdr plugin log list --plugin caius.bark-notify
```

`link` 立即注册并开始跑 hook，不需要重启 server。卸载：`herdr plugin unlink caius.bark-notify`。

## 配置

按顺序读取，先找到的生效，进程环境最后覆盖：

1. `herdr plugin config-dir caius.bark-notify` 下的 `.env`（插件自有，推荐）
2. `~/.env`（本机全局密钥文件，只挑 `BARK_*` 键）

| 键 | 默认 | 说明 |
|---|---|---|
| `BARK_KEY` | 必填 | Bark app 首页的 device key |
| `BARK_SERVER` | `https://api.day.app` | 自建 bark-server 改这里 |
| `BARK_GROUP` | `herdr` | 通知分组 |
| `BARK_LEVEL` | 空 | `active` / `timeSensitive` / `passive` |
| `BARK_SOUND` | 空 | 如 `alarm` |
| `BARK_BLOCKED_DELAY` | `3` | blocked 后重查延迟秒数，`0` 关闭 |

## 它不做什么

以下 zgxme 插件有、本插件**没有**（需要时再加，各约 5-10 行）：

- `quiet_hours` 免打扰时段
- `cooldown_seconds` 同 pane 同类去重
- `min_turn_seconds` 过滤过短的 turn
- workspace/tab/agent 的 include/exclude 通配过滤
- 推送失败重试与重投队列（现在只写 stderr，不影响 Herdr）
- 双向回复（Bark 本身只支持单向推送）

## 验证

无网络、无副作用的用例检查：

```bash
HERDR_PLUGIN_CONFIG_DIR=/tmp/x HERDR_PLUGIN_STATE_DIR=/tmp/y \
HERDR_PLUGIN_EVENT_JSON='{"data":{"type":"pane_agent_status_changed","pane_id":"w1:p1","agent_status":"idle"}}' \
python3 notify.py --dry-run
```

`--dry-run` 打印将要请求的 URL（key 已脱敏）。

## 安全边界

- 只读 `HERDR_PLUGIN_EVENT_JSON` / `HERDR_PLUGIN_CONTEXT_JSON` / `herdr agent list`，写一个 `state.json`
- 唯一外部调用是 Bark 服务器，超时 10 秒；失败只写 stderr
- 密钥只从 `.env` 读，不写进源码目录，也不出现在日志里
