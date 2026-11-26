# jobs —— 本机定时任务清单

| 任务 | 调度 | 入口 | 产出 |
|---|---|---|---|
| 每日晨报（凭据到期 · 需回复/重要通知 · 科技热点） | `0 9 * * 1-5` | `prompts/morning-brief.md` | `jobs/YYYY-MM-DD.html`（agent 自己写盘并用 Chrome 打开） |

## cron jobs 设计约束：cron → pi agent(prompts/xx.md)

一行 crontab → `pi` 读 `prompts/<job>.md` → 模型自己产出文件。

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

cron 不继承登录 shell 的 `PATH`，退回 `/usr/bin:/bin`。但**不能把整个登录 `PATH` 搬进 crontab**：crontab 单行有长度上限，超了整条 `PATH=` 会被静默丢弃（表现为任务找不到 `pi`、`python3` 缺依赖包）。只列任务真正需要的目录。

```bash
# 必须在真实 Terminal 执行：沙箱化 agent 里 crontab 写入会因 TCC 授权永久挂起
crontab -l 2>/dev/null | grep -v '^PATH=' | grep -v 'jobs/prompts/morning-brief.md' > /tmp/ct
printf 'PATH=%s\n' "$HOME/.pi/agent/bin:$HOME/.local/bin:$HOME/.pyenv/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" > /tmp/ct2
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
