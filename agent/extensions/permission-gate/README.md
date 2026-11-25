# permission-gate

基于官方 `examples/extensions/permission-gate.ts`（仅 3 模式 + select 弹窗）深度改写。只有在真实终端会话（`ctx.mode === "tui"`）里确实弹出审批弹窗、等待用户点击时，才经共享的 `agent/extensions/lib/system-notification.ts` 发送 `Glass` 通知。YOLO 自动放行、allowlist 命中、hard-deny、无 UI 直接阻断、以及非终端 UI（RPC、测试桩）全部静默。通知投递是 `await` 的，不会在弹窗已经结束后才落地；投递失败不影响命令安全拦截。

## 为什么需要它

官方 example 只做简单的命令确认弹窗，缺少：
- 彻夜无人值守时的安全底线
- 持久化 allowlist
- git force-push 到 main 的语义化判定
- YOLO 快捷模式

## 行为

### hard-deny 安全底线

`/yolo` 无条件阻断以下命令——彻夜无人值守也永不执行：
- `sudo rm -rf`
- `rm -rf /`（含 root 等效路径、路径遍历到根）
- `dd` 裸盘
- `mkfs`
- `shutdown` 族

### YOLO 会话模式

`/yolo [on|off|status]` 或确认弹窗选定后，危险命令自动放行（仍受 hard-deny 约束）。仅内存、会话级、限 armed cwd。

### YOLO 持久开关（settings.json）

```json
{ "permission-gate": { "yolo": true } }
```

写在 `~/.pi/agent/settings.json`。默认 `false`（不设置即 false）；本机为 `true`。为 `true` 时每个会话从首次工具调用起即处于 YOLO，且不限于 armed cwd（整机生效）。

- 每个会话只读一次，改完 settings.json 需开新会话生效。
- `/yolo off` 在本会话内覆盖 settings 的 `true`（不写回文件）。
- hard-deny 安全底线不受影响。

### 状态栏指示

YOLO 生效时 footer 显示 `yolo: on`（warning 色），未生效时什么都不显示（缺失即 off）。来源是 settings 开关或本会话 arming。状态 key 为 `agent-yolo`：pi 按 key 字母序拼接 footer 状态，该 key 正好排在 `auto-agent-loop` 之前。

### 持久化 allowlist

`~/.pi/agent/permission-gate-allowlist.json`，精确命令匹配，命令任一字符变化须重新授权。

### git force-push 语义化

`isGitForcePushToMain()` 按 git 最后生效 flag 判定：`--force-with-lease` 到 main 视为安全，`--force`/`-f`/`+refspec`/`--mirror` 到 main 才阻断。

## 配置

| 位置 | 作用 |
|---|---|
| `~/.pi/agent/settings.json` → `permission-gate.yolo` | 持久 YOLO 开关，默认 `false` |
| `~/.pi/agent/permission-gate-allowlist.json` | 持久化 allowlist |

## 实现

| 文件 | 作用 |
|---|---|
| `index.ts` | 入口（~415 行）：hard-deny 判定、YOLO 模式、footer `yolo: on` 指示、allowlist CRUD、git force-push 语义 |
| `../lib/system-notification.ts` | 系统通知投递（仅真实终端会话的审批弹窗播放 Glass 音效） |