#!/bin/bash
# 每日晨报：用 pi agent 生成「Gmail」+「科技热点」两个板块，合成一个 HTML，并用本机 Chrome 打开。
# 由 crontab 在工作日 9:00 调用；手动验证：NO_OPEN=1 ~/.pi/agent/jobs/morning-brief.sh
set -uo pipefail

export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
# 不覆盖 HOME：cron 会传入用户 HOME；显式设置只是给某些精简环境兜底
: "${HOME:?HOME 未设置}"
export PI_SKIP_VERSION_CHECK=1

AGENT_DIR="$HOME/.pi/agent"
JOBS_DIR="$AGENT_DIR/jobs"

PROMPT_DIR="$JOBS_DIR/prompts"
WEB_EXT="$AGENT_DIR/npm/node_modules/pi-web-access"
OUT_DIR="$JOBS_DIR"
LOG_DIR="$OUT_DIR/logs"
# 模型可选：不设 MORNING_MODEL 时用 pi 的默认模型（settings.json 的 defaultProvider/defaultModel）
MODEL="${MORNING_MODEL:-<pi default>}"
TODAY=$(date +%F)
NOW=$(date '+%F %H:%M')
HTML="$OUT_DIR/$TODAY.html"
JOB_TIMEOUT=420

mkdir -p "$OUT_DIR" "$LOG_DIR"

# 去掉模板的 YAML frontmatter，只取正文
prompt_body() { awk 'BEGIN{n=0} /^---$/{n++; next} n>=2' "$1"; }

run_job() {
  local key=$1 label=$2 prompt=$3 tools=$4 ext=${5:-}
  local log="$LOG_DIR/$TODAY-$key.log"
  local out rc
  echo "=== $(date '+%F %T') start $key model=$MODEL tools=$tools" >>"$log"
  out=$(cd "$HOME" && timeout "$JOB_TIMEOUT" pi --print --no-session -ne ${ext:+-e "$ext"} \
        ${MORNING_MODEL:+--model "$MORNING_MODEL"} --thinking low --tools "$tools" \
        -- "$(prompt_body "$PROMPT_DIR/$prompt")" 2>>"$log")
  rc=$?
  echo "=== $(date '+%F %T') exit=$rc bytes=${#out}" >>"$log"
  if [ "$rc" -ne 0 ] || [ -z "${out//[[:space:]]/}" ]; then
    printf '<section><h2>%s</h2><p class="error">生成失败（exit=%s，耗时上限 %ss）。日志：%s</p></section>\n' \
      "$label" "$rc" "$JOB_TIMEOUT" "${log/#$HOME/~}"
    return 1
  fi
  printf '%s\n' "$out"
}

CRED_HTML=$(timeout 60 python3 "$AGENT_DIR/jobs/credential-inventory.py" 2>>"$LOG_DIR/$TODAY-cred.log")
[ -n "${CRED_HTML//[[:space:]]/}" ] || CRED_HTML='<section><h2>🔑 凭据到期</h2><p class="error">检查脚本无输出，见 logs/</p></section>'
GMAIL_HTML=$(run_job gmail "📧 Gmail" morning-gmail.md "bash" "")
TECH_HTML=$(run_job tech "🤖 科技热点" morning-tech.md "web_search,fetch_content" "$WEB_EXT")

{
  cat <<EOF
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>每日晨报 · $TODAY</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 24px 72px;
    font: 16px/1.65 -apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
    background: #fbfbfd; color: #1d1d1f;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 780px; margin: 0 auto; }
  header { border-bottom: 1px solid #e5e5ea; padding-bottom: 20px; margin-bottom: 8px; }
  h1 { margin: 0; font-size: 28px; letter-spacing: -0.02em; font-weight: 650; }
  .stamp { color: #86868b; font-size: 13px; margin-top: 6px; }
  section { padding: 28px 0; border-bottom: 1px solid #ececf0; }
  section:last-of-type { border-bottom: 0; }
  h2 { margin: 0 0 14px; font-size: 17px; font-weight: 650; letter-spacing: -0.01em; }
  ul { margin: 0; padding-left: 20px; }
  li { margin: 0 0 10px; }
  li::marker { color: #b0b0b6; }
  a { color: #0066cc; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .meta { color: #86868b; font-size: 13px; }
  .summary { margin: 0 0 12px; color: #3a3a3c; }
  .empty { color: #86868b; margin: 0; }
  .error { color: #c1121f; margin: 0; }
  .bad { color: #c1121f; font-weight: 600; }
  table.cred { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.cred th { text-align: left; font-weight: 600; color: #86868b; font-size: 12px;
                  letter-spacing: .04em; padding: 0 12px 6px 0; border-bottom: 1px solid #e5e5ea; }
  table.cred td { padding: 8px 12px 8px 0; vertical-align: top; border-bottom: 1px solid #f0f0f2; }
  table.cred tr:last-child td { border-bottom: 0; }
  table.cred td:nth-child(1) { white-space: nowrap; }
  table.cred td:nth-child(2) { white-space: nowrap; }
  table.cred code { font-size: 12px; color: #3a3a3c; }
  footer { margin-top: 36px; color: #a1a1a6; font-size: 12px; text-align: center; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1c1e; color: #f2f2f7; }
    header, section { border-color: #2c2c2e; }
    a { color: #4da3ff; }
    .summary { color: #d1d1d6; }
    .stamp, .meta, .empty { color: #98989d; }
    .error { color: #ff6b6b; }
    .bad { color: #ff6b6b; }
    table.cred th { color: #98989d; border-color: #2c2c2e; }
    table.cred td { border-color: #2c2c2e; }
    table.cred code { color: #d1d1d6; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>每日晨报</h1>
    <div class="stamp">$NOW · 由 pi agent 生成</div>
  </header>
$CRED_HTML
$GMAIL_HTML
$TECH_HTML
  <footer>raw logs: ~/.pi/agent/jobs/logs/</footer>
</main>
</body>
</html>
EOF
} >"$HTML.tmp" && mv "$HTML.tmp" "$HTML"

ln -sf "$HTML" "$OUT_DIR/latest.html"

# 只保留 30 天
find "$OUT_DIR" -maxdepth 1 -name '*.html' -mtime +30 -delete 2>/dev/null
find "$LOG_DIR" -maxdepth 1 -name '*.log' -mtime +30 -delete 2>/dev/null

if [ "${NO_OPEN:-0}" != "1" ]; then
  open -a "Google Chrome" "file://$HTML"
fi
echo "$HTML"
