#!/usr/bin/env bash
set -euo pipefail

export GITLEAKS_ENABLE=0
export BETTERLEAKS_ENABLE=0

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
assert_eq() { [ "$1" = "$2" ] || fail "$3 (expected '$2', got '$1')"; }

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
  cat > "$seed/agent/settings.json" <<'JSON'
{"defaultProvider":"trendmicro","defaultModel":"trendmicro-model","packages":[],"subagents":{"fixture":"baseline"}}
JSON
  printf '{"models":[]}\n' > "$seed/agent/models.json"
  printf '{"subagents":{"fixture":"deepseek"}}\n' > "$seed/agent/profiles/pi-subagents/ds.json"
  printf '{"subagents":{"fixture":"zai"}}\n' > "$seed/agent/profiles/pi-subagents/zai.json"
  git -C "$seed" add .
  git -C "$seed" commit -qm fixture
  git -C "$seed" branch -M main
  git -C "$seed" remote add origin "$bare"
  git -C "$seed" push -qu origin main
  git --git-dir="$bare" symbolic-ref HEAD refs/heads/main
  git clone -q "$bare" "$home/.pi"
  cat > "$bin/pi" <<'SH'
#!/usr/bin/env bash
case "$1" in
  --version) echo 'pi test-version' ;;
  install) printf '%s\n' "$*" >> "$PI_TEST_LOG" ;;
  list) echo 'fixture packages: none' ;;
  *) echo "unexpected pi args: $*" >&2; exit 9 ;;
esac
SH
  chmod +x "$bin/pi"
  export fixture bare seed home bin
}

set_auth() {
  local json="$1"
  printf '%s\n' "$json" > "$home/.pi/agent/auth.json"
  chmod 600 "$home/.pi/agent/auth.json"
}

run_bootstrap() {
  if [ "${CLEAR_PROVIDER_ENV:-1}" = 1 ]; then
    env -u DEEPSEEK_API_KEY -u ZAI_API_KEY -u OPENAI_API_KEY HOME="$home" PATH="$bin:$PATH" PI_TEST_LOG="$fixture/pi.log" PI_REPO_URL="$bare" bash "$home/.pi/bootstrap.sh" "$@" < /dev/null > "$fixture/out.log" 2>&1
  else
    env HOME="$home" PATH="$bin:$PATH" PI_TEST_LOG="$fixture/pi.log" PI_REPO_URL="$bare" bash "$home/.pi/bootstrap.sh" "$@" < /dev/null > "$fixture/out.log" 2>&1
  fi
}

new_fixture multi-all
set_auth '{"deepseek":{"type":"api_key","key":"fake"},"zai":{"type":"api_key","key":"fake"},"trendmicro":{"type":"api_key","key":"fake"}}'
run_bootstrap --providers deepseek,zai,trendmicro --default-provider zai || { cat "$fixture/out.log" >&2; fail 'multi-provider install should succeed'; }
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).defaultProvider' "$home/.pi/agent/settings.json")" "zai" 'selected default provider'
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).defaultModel' "$home/.pi/agent/settings.json")" "glm-5.3-flash" 'default model follows selected provider'
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).subagents.fixture' "$home/.pi/agent/settings.json")" "zai" 'default profile follows selected provider'
echo 'PASS: all providers configured, explicit default applied'

new_fixture multi-subset
set_auth '{"deepseek":{"type":"api_key","key":"fake"}}'
run_bootstrap --providers deepseek,zai --default-provider deepseek || { cat "$fixture/out.log" >&2; fail 'available subset should succeed when optional provider has no key'; }
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).defaultProvider' "$home/.pi/agent/settings.json")" "deepseek" 'subset default provider'
grep -q 'zai.*跳过\|跳过.*zai' "$fixture/out.log" || fail 'missing optional provider should be reported as skipped'
echo 'PASS: missing optional provider is skipped'

new_fixture default-first
set_auth '{"deepseek":{"type":"api_key","key":"fake"},"zai":{"type":"api_key","key":"fake"}}'
run_bootstrap --providers zai,deepseek || { cat "$fixture/out.log" >&2; fail 'omitting --default-provider should fall back to the first entry'; }
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).defaultProvider' "$home/.pi/agent/settings.json")" "zai" 'first provider becomes default'
echo 'PASS: omitted --default-provider takes the first provider'

new_fixture trendmicro-profile
set_auth '{"trendmicro":{"type":"api_key","key":"fake"}}'
run_bootstrap --providers trendmicro || { cat "$fixture/out.log" >&2; fail 'trendmicro must keep the repository subagents profile'; }
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).subagents.fixture' "$home/.pi/agent/settings.json")" "baseline" 'trendmicro retains repository subagents profile'
echo 'PASS: trendmicro retains repository subagents profile'

new_fixture keys-file
set_auth '{}'
printf '# comment\nDEEPSEEK_API_KEY=file-key\n' > "$fixture/keys.env"
chmod 600 "$fixture/keys.env"
run_bootstrap --providers deepseek --keys-file "$fixture/keys.env" || { cat "$fixture/out.log" >&2; fail 'credentials from --keys-file should be accepted'; }
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).deepseek.key' "$home/.pi/agent/auth.json")" "file-key" 'keys-file credential persisted'
assert_eq "$(stat -f '%Lp' "$home/.pi/agent/auth.json" 2>/dev/null || stat -c '%a' "$home/.pi/agent/auth.json")" "600" 'auth file permissions after keys-file'
echo 'PASS: --keys-file credential persisted with private permissions'

new_fixture environment-key
set_auth '{}'
CLEAR_PROVIDER_ENV=0 DEEPSEEK_API_KEY='fake-env-key' run_bootstrap --providers deepseek --default-provider deepseek || { cat "$fixture/out.log" >&2; fail 'environment credentials should be accepted'; }
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).deepseek.key' "$home/.pi/agent/auth.json")" "fake-env-key" 'environment credential is persisted without a CLI key argument'
assert_eq "$(stat -c '%a' "$home/.pi/agent/auth.json" 2>/dev/null || stat -f '%Lp' "$home/.pi/agent/auth.json")" "600" 'auth file permissions'
echo 'PASS: environment credential persisted with private permissions'

new_fixture invalid-default
set_auth '{"deepseek":{"type":"api_key","key":"fake"}}'
if run_bootstrap --providers deepseek,zai --default-provider zai; then fail 'an unavailable default provider must fail'; fi
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).defaultProvider' "$home/.pi/agent/settings.json")" "trendmicro" 'failed configuration must not mutate default settings'
[ ! -e "$fixture/pi.log" ] || fail 'invalid default must be rejected before package installation'
echo 'PASS: unavailable default rejected before install without changing settings'

new_fixture invalid-list
set_auth '{}'
if run_bootstrap --providers deepseek,unknown; then fail 'unknown provider must fail'; fi
if run_bootstrap --providers deepseek,deepseek; then fail 'duplicate provider must fail'; fi
echo 'PASS: invalid and duplicate provider lists rejected'

new_fixture explicit-only
set_auth '{"zai":{"type":"api_key","key":"fake"}}'
if run_bootstrap zai; then fail 'positional provider syntax must be rejected'; fi
grep -q -- '--providers zai' "$fixture/out.log" || fail 'positional rejection should point at --providers'
printf 'ZAI_API_KEY=fake\n' > "$fixture/keys.env"
if run_bootstrap --keys-file "$fixture/keys.env"; then fail 'a keys file without a target provider must fail'; fi
grep -q 'keys-file' "$fixture/out.log" || fail 'keys-file rejection should name the flag'
if run_bootstrap --providers zai --frobnicate; then fail 'unknown flag must fail'; fi
grep -q '未知参数' "$fixture/out.log" || fail 'unknown flag should be reported'
if run_bootstrap --providers zai --ponytail-mode loud; then fail 'invalid ponytail mode must fail'; fi
if run_bootstrap --providers zai --rtk maybe; then fail 'invalid --rtk value must fail'; fi
if run_bootstrap --providers zai --keys-file "$fixture/missing.env"; then fail 'unreadable --keys-file must fail'; fi
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).defaultProvider' "$home/.pi/agent/settings.json")" "trendmicro" 'rejected arguments must not change settings'
[ ! -e "$fixture/pi.log" ] || fail 'rejected arguments must not install packages'
echo 'PASS: only explicit, validated flags are accepted'

# 零 flag: 只装 pi + repo 配置, provider/model/凭据一律不动
new_fixture no-provider
set_auth '{"zai":{"type":"api_key","key":"fake"}}'
run_bootstrap || { cat "$fixture/out.log" >&2; fail 'zero-flag bootstrap should succeed'; }
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).defaultProvider' "$home/.pi/agent/settings.json")" "trendmicro" 'repo default provider kept'
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).defaultModel' "$home/.pi/agent/settings.json")" "trendmicro-model" 'repo default model kept'
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).subagents.fixture' "$home/.pi/agent/settings.json")" "baseline" 'subagents profile kept'
assert_eq "$(node -p 'Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).sort().join(",")' "$home/.pi/agent/auth.json")" "zai" 'no provider credentials written'
grep -q '保留 repo 默认 provider/model' "$fixture/out.log" || fail 'zero-flag run should report that repo defaults were kept'
assert_eq "$(stat -f '%Lp' "$home/.pi/agent/auth.json" 2>/dev/null || stat -c '%a' "$home/.pi/agent/auth.json")" "600" 'auth permissions unchanged'
echo 'PASS: zero-flag bootstrap installs pi with repo defaults only'

# --default-provider 单独使用 = 只配这一个 provider
new_fixture default-only
set_auth '{"zai":{"type":"api_key","key":"fake"}}'
run_bootstrap --default-provider zai || { cat "$fixture/out.log" >&2; fail '--default-provider alone should configure that provider'; }
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).defaultProvider' "$home/.pi/agent/settings.json")" "zai" 'single provider becomes default'
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).defaultModel' "$home/.pi/agent/settings.json")" "glm-5.3-flash" 'model follows the single provider'
assert_eq "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).subagents.fixture' "$home/.pi/agent/settings.json")" "zai" 'profile follows the single provider'
echo 'PASS: --default-provider alone is a complete provider setup'

echo 'All bootstrap provider tests passed.'
