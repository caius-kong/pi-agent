#!/usr/bin/env bash
# bootstrap.sh 的仓库外工具依赖测试: rtk 二进制安装 + ponytail 模式落地。
# 用 stub curl/pi 在 fixture HOME 中运行, 不触碰真实机器。
set -euo pipefail

export GITLEAKS_ENABLE=0
export BETTERLEAKS_ENABLE=0

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
assert_eq() { [ "$1" = "$2" ] || fail "$3 (expected '$2', got '$1')"; }
assert_contains() { grep -q "$2" "$1" || fail "$3 (missing '$2' in $1)"; }
assert_not_contains() { grep -q "$2" "$1" && fail "$3 (unexpected '$2' in $1)"; return 0; }

# $1=fixture name $2=packages JSON (settings.json 的 packages 字段)
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
  mkdir -p "$seed/agent/profiles/pi-subagents" "$seed/agent/extensions"
  cp "$repo_root/bootstrap.sh" "$seed/bootstrap.sh"
  cat > "$seed/agent/settings.json" <<JSON
{"defaultProvider":"trendmicro","defaultModel":"trendmicro-model","packages":$2,"subagents":{"fixture":"baseline"}}
JSON
  printf '{"models":[]}\n' > "$seed/agent/models.json"
  # rtk.ts 存在 -> 触发二进制检查
  printf '// fixture rtk extension\n' > "$seed/agent/extensions/rtk.ts"
  printf '{"subagents":{"fixture":"deepseek"}}\n' > "$seed/agent/profiles/pi-subagents/ds.json"
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

  # 隔离 PATH: 只用 stub 目录与系统目录, 现场真机的 rtk (常在 /opt/homebrew/bin)
  # 因此不可见; node 从真实路径软链进来, 保证 bootstrap 的 JSON 处理可用。
  ln -s "$(command -v node)" "$bin/node"

  # stub curl: 只处理 rtk installer URL, 记录调用; STUB_RTK_INSTALL_FAIL=1 时模拟失败
  cat > "$bin/curl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CURL_LOG"
for arg in "$@"; do
  case "$arg" in
    *rtk-ai/rtk*)
      if [ "${STUB_RTK_INSTALL_FAIL:-0}" = 1 ]; then exit 22; fi
      mkdir -p "$HOME/.local/bin"
      cat > "$HOME/.local/bin/rtk" <<'RTK'
#!/usr/bin/env bash
case "$1" in
  --version) echo 'rtk 9.9.9' ;;
  *) exit 0 ;;
esac
RTK
      chmod +x "$HOME/.local/bin/rtk"
      exit 0
      ;;
  esac
done
exit 0
SH
  chmod +x "$bin/curl"

  export fixture bare seed home bin
}

set_auth() {
  printf '%s\n' "$1" > "$home/.pi/agent/auth.json"
  chmod 600 "$home/.pi/agent/auth.json"
}

run_bootstrap() {
  env HOME="$home" PATH="$home/.local/bin:$bin:/usr/bin:/bin" PI_TEST_LOG="$fixture/pi.log" \
    CURL_LOG="$fixture/curl.log" PI_REPO_URL="$bare" \
    bash "$home/.pi/bootstrap.sh" "$@" < /dev/null > "$fixture/out.log" 2>&1
}

pony_config() { printf '%s\n' "${XDG_CONFIG_HOME:-$home/.config}/ponytail/config.json"; }
pony_mode() { node -p 'String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).defaultMode||"")' "$1"; }

PONYTAIL_PKG='["npm:@dietrichgebert/ponytail@5.1.0"]'

# 1. rtk.ts 存在且 PATH 中缺 rtk -> 走官方 installer, 装完可解析
new_fixture rtk-missing "$PONYTAIL_PKG"
set_auth '{"deepseek":{"type":"api_key","key":"fake"}}'
run_bootstrap --providers deepseek --default-provider deepseek || { cat "$fixture/out.log" >&2; fail 'bootstrap should succeed with rtk installer stub'; }
assert_eq "$(command -v "$home/.local/bin/rtk" >/dev/null 2>&1 && echo yes)" "yes" 'rtk installer output present'
assert_contains "$fixture/curl.log" 'rtk-ai/rtk' 'official rtk installer URL should be requested'
assert_contains "$fixture/out.log" 'rtk 安装完成' 'install success should be reported'
echo 'PASS: rtk installed via official installer when missing'

# 2. rtk 已在 PATH -> 不调用 installer
new_fixture rtk-present "$PONYTAIL_PKG"
set_auth '{"deepseek":{"type":"api_key","key":"fake"}}'
printf '#!/usr/bin/env bash\n[ "$1" = --version ] && echo "rtk 1.2.3"\nexit 0\n' > "$bin/rtk"
chmod +x "$bin/rtk"
run_bootstrap --providers deepseek --default-provider deepseek || { cat "$fixture/out.log" >&2; fail 'bootstrap should succeed with existing rtk'; }
assert_not_contains "$fixture/curl.log" 'rtk-ai/rtk' 'installer must not run when rtk already resolves'
assert_contains "$fixture/out.log" 'rtk 已安装: rtk 1.2.3' 'existing rtk should be reported'
echo 'PASS: existing rtk is left alone'

# 3. installer 失败 -> 不中止 bootstrap, 且明确报告
new_fixture rtk-fail "$PONYTAIL_PKG"
set_auth '{"deepseek":{"type":"api_key","key":"fake"}}'
STUB_RTK_INSTALL_FAIL=1 run_bootstrap --providers deepseek --default-provider deepseek || { cat "$fixture/out.log" >&2; fail 'rtk installer failure must not abort bootstrap'; }
assert_contains "$fixture/out.log" 'rtk 安装失败' 'installer failure should be reported'
assert_contains "$fixture/out.log" '✗ rtk' 'self-check should flag missing rtk'
echo 'PASS: rtk installer failure is loud but non-fatal'

# 4. ponytail 已声明且无配置 -> 写入 defaultMode=off
new_fixture pony-absent "$PONYTAIL_PKG"
set_auth '{"deepseek":{"type":"api_key","key":"fake"}}'
run_bootstrap --providers deepseek --default-provider deepseek || { cat "$fixture/out.log" >&2; fail 'bootstrap should succeed'; }
assert_eq "$(pony_mode "$(pony_config)")" "off" 'ponytail defaultMode should be written as off'
echo 'PASS: ponytail config written when absent'

# 5. 已有不同值 -> 备份 + 改写, 并保留其他键
new_fixture pony-differs "$PONYTAIL_PKG"
set_auth '{"deepseek":{"type":"api_key","key":"fake"}}'
mkdir -p "$home/.config/ponytail"
printf '{\n  "defaultMode": "full",\n  "quietStartup": true\n}\n' > "$(pony_config)"
run_bootstrap --providers deepseek --default-provider deepseek || { cat "$fixture/out.log" >&2; fail 'bootstrap should succeed'; }
assert_eq "$(pony_mode "$(pony_config)")" "off" 'ponytail mode should be updated to off'
assert_eq "$(node -p 'String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).quietStartup)' "$(pony_config)")" "true" 'unrelated ponytail keys must be preserved'
assert_eq "$(ls "$home/.config/ponytail" | grep -c 'config.json.bak.')" "1" 'a backup should be created before overwriting'
assert_contains "$fixture/out.log" '已备份原 ponytail 配置' 'backup should be reported'
echo 'PASS: differing ponytail config is backed up, merged, and updated'

# 6. 已是目标值 -> 不重复写、不产生备份
new_fixture pony-idempotent "$PONYTAIL_PKG"
set_auth '{"deepseek":{"type":"api_key","key":"fake"}}'
mkdir -p "$home/.config/ponytail"
printf '{"defaultMode":"off"}\n' > "$(pony_config)"
before="$(cat "$(pony_config)")"
run_bootstrap --providers deepseek --default-provider deepseek || { cat "$fixture/out.log" >&2; fail 'bootstrap should succeed'; }
assert_eq "$(cat "$(pony_config)")" "$before" 'matching config must not be rewritten'
assert_eq "$(ls "$home/.config/ponytail" | grep -c 'config.json.bak.')" "0" 'no backup when value already matches'
assert_contains "$fixture/out.log" 'ponytail 默认模式已是 off' 'no-op should be reported'
echo 'PASS: ponytail config write is idempotent'

# 7. XDG_CONFIG_HOME 被尊重
new_fixture pony-xdg "$PONYTAIL_PKG"
set_auth '{"deepseek":{"type":"api_key","key":"fake"}}'
xdg="$fixture/xdg"
run_bootstrap_xdg() {
  env HOME="$home" PATH="$home/.local/bin:$bin:/usr/bin:/bin" PI_TEST_LOG="$fixture/pi.log" \
    CURL_LOG="$fixture/curl.log" PI_REPO_URL="$bare" XDG_CONFIG_HOME="$xdg" \
    bash "$home/.pi/bootstrap.sh" "$@" < /dev/null > "$fixture/out.log" 2>&1
}
run_bootstrap_xdg --providers deepseek --default-provider deepseek || { cat "$fixture/out.log" >&2; fail 'bootstrap should succeed with XDG_CONFIG_HOME'; }
assert_eq "$(pony_mode "$xdg/ponytail/config.json")" "off" 'XDG_CONFIG_HOME should be honored'
[ -e "$home/.config/ponytail/config.json" ] && fail 'must not also write ~/.config when XDG_CONFIG_HOME is set'
echo 'PASS: XDG_CONFIG_HOME is honored'

# 8. ponytail 未声明 -> 不创建任何配置
new_fixture pony-undeclared '[]'
set_auth '{"deepseek":{"type":"api_key","key":"fake"}}'
run_bootstrap --providers deepseek --default-provider deepseek || { cat "$fixture/out.log" >&2; fail 'bootstrap should succeed without ponytail'; }
[ -e "$(pony_config)" ] && fail 'ponytail config must not be created when the package is not declared'
echo 'PASS: undeclared ponytail is left alone'

# 9. --rtk skip -> 缺 rtk 也不跑 installer, 只报告
new_fixture rtk-skip "$PONYTAIL_PKG"
set_auth '{"deepseek":{"type":"api_key","key":"fake"}}'
run_bootstrap --providers deepseek --default-provider deepseek --rtk skip || { cat "$fixture/out.log" >&2; fail '--rtk skip should not abort bootstrap'; }
assert_not_contains "$fixture/curl.log" 'rtk-ai/rtk' '--rtk skip must not call the installer'
assert_contains "$fixture/out.log" '跳过 rtk' 'skip should be reported'
assert_contains "$fixture/out.log" '✗ rtk' 'self-check should still flag missing rtk'
echo 'PASS: --rtk skip leaves rtk alone'

# 10. --ponytail-mode 取值直接落地
new_fixture pony-mode-full "$PONYTAIL_PKG"
set_auth '{"deepseek":{"type":"api_key","key":"fake"}}'
run_bootstrap --providers deepseek --default-provider deepseek --ponytail-mode full || { cat "$fixture/out.log" >&2; fail 'bootstrap should succeed with --ponytail-mode full'; }
assert_eq "$(pony_mode "$(pony_config)")" "full" '--ponytail-mode full should be written as given'
echo 'PASS: --ponytail-mode writes the requested level'

# 11. --ponytail-mode skip -> 不写任何 ponytail 配置
new_fixture pony-mode-skip "$PONYTAIL_PKG"
set_auth '{"deepseek":{"type":"api_key","key":"fake"}}'
run_bootstrap --providers deepseek --default-provider deepseek --ponytail-mode skip || { cat "$fixture/out.log" >&2; fail 'bootstrap should succeed with --ponytail-mode skip'; }
[ -e "$(pony_config)" ] && fail '--ponytail-mode skip must not create the config'
echo 'PASS: --ponytail-mode skip leaves ponytail untouched'

echo 'All bootstrap ext-tool tests passed.'
