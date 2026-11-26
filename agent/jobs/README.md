# jobs —— 本机定时任务清单

| 任务 | 调度 | 入口 | 产出 |
|---|---|---|---|
| 每日晨报（凭据到期 · 需回复/重要通知 · 科技热点） | `0 9 * * 1-5` | crontab 调 `pi` + `prompts/morning-brief.md` | `jobs/YYYY-MM-DD.html`（agent 自己写盘并用 Chrome 打开） |

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
printf 'export GOG_KEYRING_BACKEND=file\nexport GOG_KEYRING_PASSWORD=%s\nexport PATH="$HOME/.local/bin:$PATH"\n' "$(openssl rand -base64 18)" > cron.env && chmod 600 cron.env
```

两个文件都不入库；到期日从 JWT 的 `exp` 解出，轮换后不用改。
模型不配置：默认用 pi 的 `defaultProvider`/`defaultModel`；要覆盖就在环境里给 `MORNING_MODEL`。
`cron.env` 补 cron 缺的环境：cron 读不到登录钥匙串，gog 必须走 file keyring（密码要与 `gog auth import --email <me> --refresh-token-stdin` 时用的一致）；cron 的 `PATH` 也不含 `~/.local/bin`。

### 安装

整条流水线就是一行 crontab，没有脚本：`pi` 读 prompt，子代理并行取数，模型自己把整份 HTML 写到当天文件并打开。
`pi-subagents` / `pi-web-access` 在 `settings.json` 的 `packages` 里，默认就加载，不需要 `-e`；crontab 顶部已有 `PATH=`，cwd 本来就是 `$HOME`，也不需要重复。

```bash
# 装（必须在真实 Terminal 执行；沙箱化 agent 里会因 TCC 授权永久挂起）
crontab -l 2>/dev/null | grep -v 'jobs/prompts/morning-brief.md' > /tmp/ct; printf '0 9 * * 1-5 . $HOME/.pi/agent/jobs/cron.env && pi -p --no-session "$(cat $HOME/.pi/agent/jobs/prompts/morning-brief.md)" >> $HOME/.pi/agent/jobs/logs/cron.log 2>&1\n' >> /tmp/ct && crontab /tmp/ct && crontab -l | tail -1

# 验收：手动跑同一条命令（空环境 = cron 环境），stdout 只应有一行「晨报已生成：<路径>」
env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin sh -c '. $HOME/.pi/agent/jobs/cron.env && pi -p --no-session "$(cat $HOME/.pi/agent/jobs/prompts/morning-brief.md)"'
f=~/.pi/agent/jobs/$(date +%F).html
head -c 15 "$f"; echo            # <!doctype html>
grep -c '<h2' "$f"               # 6（EMAILS 下的三个子块是 h3）
grep -c 'class="error"' "$f"     # 0
grep -c '_今日' "$f"              # 0（空态必须是 <p class="empty">，不能漏 Markdown 下划线）
grep -cE 'KEYS|需要回复|重要通知|其余未读|AI 热点|Hacker News|GitHub Trending|Simon Willison' "$f"   # 8 个板块都在
```

cron 不加载 shell 配置，所以那一行自己 `. cron.env`。
