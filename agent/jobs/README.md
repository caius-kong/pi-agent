# jobs —— 本机定时任务清单

| 任务 | 调度 | 入口 | 产出 |
|---|---|---|---|
| 每日晨报（凭据到期 · 需回复/重要通知 · 科技热点） | `0 9 * * 1-5` | `prompts/morning-brief.md` | `jobs/YYYY-MM-DD.html`（agent 自己写盘并用 Chrome 打开） |

## cron jobs 设计约束：cron → pi agent(prompts/xx.md)

本机定时任务只有一种形态：**一行 crontab → `pi` 读 `prompts/<job>.md` → 模型自己产出文件**。没有 shell 脚本层，没有中间拼装。

| 约束 | 原因 |
|---|---|
| 一行 crontab，不套 `.sh` | 脚本层会把 prompt 的职责切碎（拼 HTML、重试、传参），出错时定位不到层 |
| prompt 是唯一入口，也是唯一任务定义 | 改行为只改 `.md`；子代理读同一份文件的对应小节，不靠父代理转述 |
| 输出路径写死在 prompt 里 | 不写死则由模型自选目录，下游无法定位 |
| 不加 `--no-session` | 没有 session 记录，ccusage 统计不到这次运行的费用 |
| 扩展靠 `settings.json` 的 `packages` 默认加载 | 不在 crontab 里写 `-e <路径>`，那是重复配置 |
| `PATH` 整条写进 crontab 顶部 | cron 不继承登录 shell 的 `PATH`；缺一条报「binary not found」，同名二进制散在多处时还会静默用错版本 |
| 其余环境变量放 `jobs/cron.env`（600，不入库） | cron 读不到登录钥匙串这类交互态资源 |
| 日志重定向到 `jobs/logs/cron.log` | cron 自身没有输出通道 |

## Usage

### 依赖

```bash
brew install steipete/tap/gogcli && gog auth login   # gog
pi install npm:pi-subagents                           # subagent（scout / researcher）
pi install npm:pi-web-access                          # web_search、fetch_content
```

另需 `pi`、`/usr/bin/python3`、Google Chrome。

### 配置

```bash
cd ~/.pi/agent/jobs
cp credentials.example.json credentials.json   # locations[].regex 的第 1 个捕获组是 token
printf 'export GOG_KEYRING_BACKEND=file\nexport GOG_KEYRING_PASSWORD=%s\n' "$(openssl rand -base64 18)" > cron.env && chmod 600 cron.env
```

`credentials.json` 与 `cron.env` 都不入库。到期日从 JWT 的 `exp` 解出，轮换后不用改。
`cron.env` 只放 gog 需要的两个变量：cron 读不到登录钥匙串，gog 必须走 file keyring（密码要与 `gog auth import --email <me> --refresh-token-stdin` 时用的一致）。
模型不配置：默认用 pi 的 `defaultProvider`/`defaultModel`；要覆盖就在环境里给 `MORNING_MODEL`。

### 安装

```bash
# 必须在真实 Terminal 执行：沙箱化 agent 里 crontab 写入会因 TCC 授权永久挂起
crontab -l 2>/dev/null | grep -v '^PATH=' | grep -v 'jobs/prompts/morning-brief.md' > /tmp/ct
printf 'PATH=%s\n' "$(echo "$PATH" | tr : '\n' | awk '!s[$0]++' | paste -sd:)" > /tmp/ct2
cat /tmp/ct >> /tmp/ct2
printf '0 9 * * 1-5 . $HOME/.pi/agent/jobs/cron.env && pi -p "$(cat $HOME/.pi/agent/jobs/prompts/morning-brief.md)" >> $HOME/.pi/agent/jobs/logs/cron.log 2>&1\n' >> /tmp/ct2
crontab /tmp/ct2 && crontab -l | tail -1
```

### 验收

用空环境跑同一条命令（等价 cron 环境），stdout 应只有一行 `晨报已生成：<路径>`。

```bash
env -i HOME="$HOME" PATH="$(crontab -l | grep '^PATH=' | sed 's/^PATH=//')" \
  sh -c '. $HOME/.pi/agent/jobs/cron.env && pi -p "$(cat $HOME/.pi/agent/jobs/prompts/morning-brief.md)"'

f=~/.pi/agent/jobs/$(date +%F).html
head -c 15 "$f"; echo            # <!doctype html>
grep -c '<h2' "$f"               # 6（EMAILS 下的三个子块是 h3）
grep -c 'class="error"' "$f"     # 0
grep -c '_今日' "$f"              # 0（空态必须是 <p class="empty">，不能漏 Markdown 下划线）
grep -cE '需要回复|重要通知|其余未读|AI 热点|Hacker News|GitHub Trending|Simon Willison' "$f"   # 7
```
