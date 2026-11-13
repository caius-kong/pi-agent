#!/usr/bin/env bash
set -euo pipefail

export GITLEAKS_ENABLE=0
export BETTERLEAKS_ENABLE=0

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
assert_eq() { [ "$1" = "$2" ] || fail "$3 (expected '$2', got '$1')"; }
assert_perm() { assert_eq "$(stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1")" "$2" "$3"; }

new_fixture() {
  fixture="$tmp/$1"
  bare="$fixture/origin.git"
  seed="$fixture/seed"
  home="$fixture/home"
  bin="$fixture/bin"
  mkdir -p "$fixture" "$bin" "$home"
  git init --bare -q "$bare"
  git init -q "$seed"
  git -C "$seed" config user.name "Bootstrap Test"
  git -C "$seed" config user.email "bootstrap-test@example.invalid"
  mkdir -p "$seed/agent/profiles/pi-subagents"
  cp "$repo_root/bootstrap.sh" "$seed/bootstrap.sh"
  printf '{"defaultProvider":"trendmicro","defaultModel":"trendmicro-model","packages":[],"subagents":{}}\n' > "$seed/agent/settings.json"
  printf '{"models":[]}\n' > "$seed/agent/models.json"
  git -C "$seed" add .
  git -C "$seed" commit -qm fixture
  git -C "$seed" branch -M main
  git -C "$seed" remote add origin "$bare"
  git -C "$seed" push -qu origin main
  git --git-dir="$bare" symbolic-ref HEAD refs/heads/main
  git clone -q "$bare" "$home/.pi"
  mkdir -p "$home/.pi/agent"
  printf '{"trendmicro":{"type":"api_key","key":"test-provider-key"}}\n' > "$home/.pi/agent/auth.json"
  chmod 600 "$home/.pi/agent/auth.json"
  ln -s "$(command -v node)" "$bin/node"
  cat > "$bin/pi" <<'SH'
#!/usr/bin/env bash
case "$1" in
  --version) echo 'pi test-version' ;;
  install) printf '%s\n' "$*" >> "$PI_TEST_LOG" ;;
  list) echo 'fixture packages: none' ;;
  *) exit 9 ;;
esac
SH
  cat > "$bin/npx" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NPX_LOG"
api_url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --api-url) api_url="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$api_url" ] || exit 7
mkdir -p "$HOME/.hindsight/coding-agents/dist"
if [ -f "$HOME/.hindsight/coding-agent.json" ] && [ ! -f "$HOME/.hindsight/coding-agent.json.hindsight-backup" ]; then cp "$HOME/.hindsight/coding-agent.json" "$HOME/.hindsight/coding-agent.json.hindsight-backup"; fi
printf '// installer stub\n' > "$HOME/.hindsight/coding-agents/dist/pi.js"
node - "$HOME/.hindsight/coding-agent.json" "$api_url" "$HOME/.pi/agent/settings.json" "$HOME/.hindsight/coding-agents/dist/pi.js" <<'JS'
const fs=require('fs');
const [config,url,settings,extension]=process.argv.slice(2);
fs.mkdirSync(require('path').dirname(config),{recursive:true});
let c={};try{c=JSON.parse(fs.readFileSync(config,'utf8'))}catch{}
c.serverMode='self-hosted';c.apiUrl=url;fs.writeFileSync(config,JSON.stringify(c,null,2)+'\n');
const s=JSON.parse(fs.readFileSync(settings,'utf8'));s.extensions=[...(s.extensions||[]),extension];fs.writeFileSync(settings,JSON.stringify(s,null,2)+'\n');
JS
SH
  chmod +x "$bin/pi" "$bin/npx"
  export fixture bare seed home bin
}

# 统一的启动封装: 只带必备 provider 参数, Hindsight 相关参数由调用方追加。
# $1 用 "env" 时表示需要显式控制环境变量, 其余参数原样透传。
run_env() { # 剩余参数 = env 赋值 + bootstrap 参数
  env HOME="$home" PATH="$bin:/usr/bin:/bin" PI_REPO_URL="$bare" \
    PI_TEST_LOG="$fixture/pi.log" NPX_LOG="$fixture/npx.log" "$@"
}

run_bootstrap() { # 剩余参数 = 追加的 bootstrap 参数
  run_env bash "$home/.pi/bootstrap.sh" --providers trendmicro --default-provider trendmicro "$@" \
    < /dev/null > "$fixture/out.log" 2>&1
}

cfg() { node -p "String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).$1||'')" "$home/.hindsight/coding-agent.json"; }

# 未给 --hindsight-api-url: 不装扩展、不写任何 Hindsight 文件。
new_fixture no-url
run_bootstrap || { cat "$fixture/out.log" >&2; fail 'bootstrap without Hindsight flags should succeed'; }
[ ! -e "$fixture/npx.log" ] || fail 'installer ran without --hindsight-api-url'
[ ! -e "$home/.hindsight/coding-agent.json" ] || fail 'config written without --hindsight-api-url'
echo 'PASS: without --hindsight-api-url nothing Hindsight-related happens'

# 非 loopback 的 HTTP 在调用 installer / 写配置之前就被拒绝。
new_fixture insecure-url
HINDSIGHT_API_TOKEN='test-token-never-log' run_env \
  bash "$home/.pi/bootstrap.sh" --providers trendmicro --default-provider trendmicro \
  --hindsight-api-url http://memory.example.test \
  < /dev/null > "$fixture/out.log" 2>&1 && fail 'non-loopback HTTP must be rejected'
[ ! -e "$fixture/npx.log" ] || fail 'insecure URL reached the installer'
[ ! -e "$home/.hindsight/coding-agent.json" ] || fail 'insecure URL wrote the Hindsight config'
grep -q 'HTTPS' "$fixture/out.log" || fail 'rejection should explain the HTTPS requirement'
echo 'PASS: non-loopback HTTP is rejected before the installer runs'

# --hindsight-api-url + 环境变量 token: 无 TTY 也能完成接入, URL 归一化。
new_fixture url-env-token
HINDSIGHT_API_TOKEN='env-token-never-log' run_env \
  bash "$home/.pi/bootstrap.sh" --providers trendmicro --default-provider trendmicro \
  --hindsight-api-url https://memory.example.test/ \
  < /dev/null > "$fixture/out.log" 2>&1 || { cat "$fixture/out.log" >&2; fail 'env-token install failed'; }
assert_eq "$(cfg apiUrl)" 'https://memory.example.test' 'trailing slash stripped from API URL'
assert_eq "$(cfg apiToken)" 'env-token-never-log' 'env token persisted'
assert_eq "$(cfg serverMode)" 'self-hosted' 'server mode recorded'
assert_perm "$home/.hindsight/coding-agent.json" '600' 'config permissions'
assert_perm "$home/.hindsight" '700' 'config directory permissions'
grep -q -- '--api-url https://memory.example.test' "$fixture/npx.log" || fail 'installer did not receive API URL'
! grep -q 'env-token-never-log' "$fixture/npx.log" || fail 'env token leaked to installer arguments'
node - "$home/.pi/agent/settings.json" "$home/.hindsight/coding-agents/dist/pi.js" <<'JS'
const fs=require('fs');const [f,ext]=process.argv.slice(2);if(!JSON.parse(fs.readFileSync(f)).extensions.includes(ext))process.exit(1)
JS
grep -q 'hindsight_diagnose' "$fixture/out.log" || fail 'success should tell the next verification step'
echo 'PASS: --hindsight-api-url installs with an env token and no TTY'

# --hindsight-token-file: token 从文件首行读取, 不进 argv。
new_fixture url-token-file
printf 'file-token-never-log\n' > "$fixture/token.txt"
chmod 600 "$fixture/token.txt"
env -u HINDSIGHT_API_TOKEN HOME="$home" PATH="$bin:/usr/bin:/bin" PI_REPO_URL="$bare" \
  PI_TEST_LOG="$fixture/pi.log" NPX_LOG="$fixture/npx.log" \
  bash "$home/.pi/bootstrap.sh" --providers trendmicro --default-provider trendmicro \
  --hindsight-api-url https://memory.example.test --hindsight-token-file "$fixture/token.txt" \
  < /dev/null > "$fixture/out.log" 2>&1 || { cat "$fixture/out.log" >&2; fail 'token-file install failed'; }
assert_eq "$(cfg apiToken)" 'file-token-never-log' 'token read from --hindsight-token-file'
! grep -q 'file-token-never-log' "$fixture/npx.log" || fail 'token-file value leaked to installer arguments'
echo 'PASS: --hindsight-token-file supplies the token without argv exposure'

# 有 URL 但没有任何 token 来源: fail closed, 不跑 installer、不写配置。
new_fixture url-no-token
env -u HINDSIGHT_API_TOKEN HOME="$home" PATH="$bin:/usr/bin:/bin" PI_REPO_URL="$bare" \
  PI_TEST_LOG="$fixture/pi.log" NPX_LOG="$fixture/npx.log" \
  bash "$home/.pi/bootstrap.sh" --providers trendmicro --default-provider trendmicro \
  --hindsight-api-url https://memory.example.test \
  < /dev/null > "$fixture/out.log" 2>&1 && fail 'missing token must fail'
[ ! -e "$fixture/npx.log" ] || fail 'installer ran without a token'
[ ! -e "$home/.hindsight/coding-agent.json" ] || fail 'config written without a token'
grep -q 'HINDSIGHT_API_TOKEN' "$fixture/out.log" || fail 'failure should name the accepted token sources'
echo 'PASS: missing token fails closed before the installer'

# 已有配置时: 安装器备份保留, 新 token 覆盖旧值, 权限仍为 600。
new_fixture existing-config
mkdir -p "$home/.hindsight"
printf '{"serverMode":"daemon","daemonProfile":"coding-agent","apiToken":"stale"}\n' > "$home/.hindsight/coding-agent.json"
chmod 644 "$home/.hindsight/coding-agent.json"
HINDSIGHT_API_TOKEN='fresh-token-never-log' run_env \
  bash "$home/.pi/bootstrap.sh" --providers trendmicro --default-provider trendmicro \
  --hindsight-api-url https://memory.example.test \
  < /dev/null > "$fixture/out.log" 2>&1 || { cat "$fixture/out.log" >&2; fail 're-install over existing config failed'; }
assert_eq "$(cfg apiToken)" 'fresh-token-never-log' 'token replaced on re-install'
assert_eq "$(cfg daemonProfile)" '' 'legacy daemon profile removed'
assert_perm "$home/.hindsight/coding-agent.json" '600' 'config permissions after re-install'
assert_perm "$home/.hindsight/coding-agent.json.hindsight-backup" '600' 'installer backup permissions'
echo 'PASS: re-install replaces credentials and keeps files private'

echo 'All bootstrap Hindsight tests passed.'
