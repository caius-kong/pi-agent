# notify

Pi 真正停下来等待用户输入时发送一次系统通知。

## 为什么需要它

Pi 的 `agent_settled` 事件表示本轮最终结束、不会再自动 retry/continuation，但 Pi 本身不会发送 OS 级通知。长任务后台运行时（尤其是 Herdr pane 或隐藏终端），用户需要一个外部通知来切回上下文。

## 行为

1. **触发时机** — `agent_settled` 后等一个 grace，确认没有 extension 自动续跑、没有排队消息、也没有已观测到的后台 subagent 仍在运行才发。只在 TUI 且 agent idle 时发一次通知。`pi-subagents` 的后台任务事件集成是可选的；若要让 notify 识别其后台任务，请另行安装并启用 `pi-subagents`（`pi install npm:pi-subagents`）。Pi 不会因代码引用而自动级联安装；若缺少该 extension，notify 无法观察其后台任务，仍可能在子代理运行时发出通知。
2. **标题** — 独立运行时标题用 cwd 最后一级目录；Herdr 下查询 Workspace 与 Tab 名，标题形如 `Pi · payments-api / tests`，正文附 pane ID。标签查询失败时回退稳定 ID。
3. **投递链** — macOS 使用 `terminal-notifier`，失败时回退 `osascript`；Herdr pane 使用本地 `notification.show` API；Linux 使用 `notify-send`，系统通道不可用时才回退 OSC 777。
4. **macOS 显示时长** — 通知 API 不支持逐条指定横幅显示秒数。若希望通知常驻直到关闭，在"系统设置 → 通知 → terminal-notifier"把提醒样式设为"提醒（Alerts）"；"横幅（Banners）"时长由 macOS 管理。

## 共享实现

平台投递逻辑放在 `agent/extensions/lib/system-notification.ts`，供 `notify/index.ts` 与 `permission-gate/index.ts` 共用，避免各自维护重复的 OS 分支。OSC 777 是终端协议，不保证跨终端或透过 Herdr pane；Windows/其他桌面环境需要按目标环境单独验收。

## 配置

macOS 需允许 `terminal-notifier` 通知；Herdr 需 `[ui.toast] delivery = "system"`。

## 实现

| 文件 | 作用 |
|---|---|
| `index.ts` | 入口：settle 判定 + grace 等待 + 通知编排 |
| `../lib/system-notification.ts` | 跨 OS 通知投递（macOS / Linux / Herdr） |