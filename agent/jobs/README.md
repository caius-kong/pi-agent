# jobs —— 本机定时任务清单

| 任务 | 调度 | 入口 | 产出 |
|---|---|---|---|
| 每日晨报（凭据到期 · 需回复/重要通知 · 科技热点） | `0 9 * * 1-5` | `agent/jobs/morning-brief.sh` | `jobs/YYYY-MM-DD.html`（自动用 Chrome 打开） |

## Usage

### 依赖

```bash
brew install coreutils steipete/tap/gogcli && gog auth login   # timeout / gog
pi install npm:pi-subagents                                     # subagent（scout 查邮件 / researcher 查热点）
pi install npm:pi-web-access                                    # web_search、fetch_content（子代理要用）
```

另需 `pi`、`python3`、Google Chrome。

### 配置

```bash
cd ~/.pi/agent/jobs
cp credentials.example.json credentials.json   # locations[].regex 的第 1 个捕获组是 token
printf 'export GOG_KEYRING_BACKEND=file\nexport GOG_KEYRING_PASSWORD=%s\n' "$(openssl rand -base64 18)" > gog.env && chmod 600 gog.env
```

两个文件都不入库；到期日从 JWT 的 `exp` 解出，轮换后不用改。
模型不配置：默认用 pi 的 `defaultProvider`/`defaultModel`；要覆盖就在环境里给 `MORNING_MODEL`。
`gog.env` 是给 cron 用的：cron 读不到登录钥匙串，必须让 gog 走 file keyring，并用同一组环境变量把 token 导进去（`gog auth import --email <me> --refresh-token-stdin`）。

### 安装

```bash
# 先手动跑一次（空环境 = cron 环境）：确认 jobs/YYYY-MM-DD.html 存在、grep -c 'class="error"' 为 0、<h2> 有 8 个
env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin NO_OPEN=1 ~/.pi/agent/jobs/morning-brief.sh

# 装 crontab（必须在真实 Terminal 执行；沙箱化 agent 里会因 TCC 授权永久挂起）
{ crontab -l 2>/dev/null; echo; printf '0 9 * * 1-5 %s/.pi/agent/jobs/morning-brief.sh >> %s/.pi/agent/jobs/logs/cron.log 2>&1\n' "$HOME" "$HOME"; } | crontab -
crontab -l | tail -2
```

cron 需绝对路径、不加载 shell 配置（脚本自己 `export PATH`）。首次真实触发后要人眼确认 Chrome 被拉起——这是唯一无法提前自动验证的环节。
