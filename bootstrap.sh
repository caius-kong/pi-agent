#!/usr/bin/env bash
# pi 一键安装脚本 —— 安装"我的自定义 pi agent"
#
# 全部配置都由显式参数提供, 不做任何交互提问; 参数表见 README 或 --help,
# Hindsight 部署/迁移 SOP 见 docs/hindsight-pi-deployment.md。
#
# 零参数运行: 只装 pi + 本仓库配置, 保留 repo 默认 provider/model, 不写任何凭据。
# 需要 provider/凭据/Hindsight 时再加参数 (如 --default-provider zai --keys-file <file>)。
#
# 执行内容: clone 或刷新 ~/.pi, 安装 settings.json 声明的 packages, 按参数收尾:
#     deepseek   -> 默认模型 deepseek-v4-flash, subagents 应用 ds profile (需自备 DeepSeek key)
#     zai        -> 默认模型 glm-5.3-flash (Z.AI 官方 provider, 内置目录), subagents 应用 zai profile (需自备 ZAI_API_KEY)
#     trendmicro -> 配置原样 (repo 默认, 公司网关; 需自备网关 key)
#   多 provider 只配置有可用凭据的所选项; 缺凭据的非默认项跳过并报告。
#   默认 provider 必须有凭据, 并决定默认模型/subagents profile。
#
# ~/.pi 已存在: origin 同 repo -> 刷新(git pull --ff-only + 补装 packages); 否则 abort。
# 全新机器:
#   git clone https://github.com/caius-kong/pi-agent.git /tmp/pi-bootstrap
#   /tmp/pi-bootstrap/bootstrap.sh            # 先装起来; 需要 provider 时再加参数重跑
#
# 会话迁移不在本脚本职责内, 需要时手动执行:
#   rsync -a <old-mac>:'.pi/agent/sessions' ~/.pi/agent/
#   rsync -a <old-mac>:'.pi/agent/auth.json .pi/agent/web-search.json' ~/.pi/agent/
#
# 仓库外的工具依赖也由本脚本负责 (它们不在 ~/.pi 里, git 同步不到):
#   rtk 二进制     -> rtk.ts 存在且 PATH 中缺失时, 跑官方 installer (装到 ~/.local/bin)
#   ponytail 模式  -> 按 --ponytail-mode 写入 ${XDG_CONFIG_HOME:-~/.config}/ponytail/config.json
#
# 职责边界: 不碰 ~/.ssh、不做 git push、不管 ~/.agents、不覆盖 auth.json 已有 provider 条目。
# 除上述 rtk/ponytail 两处外不写 ~/.pi 之外的位置。
# git/curl (远端为 ssh 形态时另需 ssh) 属用户自备环境, 缺失时直接报错退出。

set -euo pipefail

PI_REPO_URL="${PI_REPO_URL:-https://github.com/caius-kong/pi-agent.git}"

die() { printf '错误: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: bootstrap.sh [--providers <list>] [--default-provider <p>] [选项]

  不带 provider 参数                只装 pi + repo 配置, 保留 repo 默认 provider/model
  --providers <a,b,...>          要配置的 provider: deepseek|zai|trendmicro (逗号分隔)
  --default-provider <p>         默认 provider; 不给 --providers 时可单独用, 等价于只配这一个
  --keys-file <path>             凭据文件 (KEY=VALUE), 也可用同名环境变量
  --hindsight-api-url <url>      接入已部署的 Hindsight API (HTTPS, 或本机 loopback HTTP)
  --hindsight-token-file <path>  Hindsight token 文件 (取首行); 否则读 HINDSIGHT_API_TOKEN
  --rtk <install|skip>           缺少 rtk 时是否跑官方 installer (默认 install)
  --ponytail-mode <m>            ponytail defaultMode: off|lite|full|ultra|skip (默认 off)
  -h, --help                     显示本帮助

使用场景见 README; Hindsight 部署与旧数据迁移见 docs/hindsight-pi-deployment.md
EOF
}

# 任意 git URL -> "owner/repo" (协议/host/别名无关), 用于 origin 匹配
repo_slug() {
  local u="${1%.git}"
  u="${u#*://}"
  u="${u#*:}"
  local tail="${u##*/}"
  local rest="${u%/*}"
  printf '%s/%s' "${rest##*/}" "$tail"
}

ensure_env() { # $1 = 生效的 git 远端 (决定是否需要 ssh)
  local cmd
  for cmd in git curl; do
    command -v "${cmd}" >/dev/null 2>&1 || die "缺少 ${cmd}，请自行安装后重跑"
  done
  case "$1" in
    git@*:*|ssh://*)
      command -v ssh >/dev/null 2>&1 || die "缺少 ssh (远端为 ssh 形态)，请自行安装后重跑"
      ;;
  esac
}

ensure_pi() {
  if command -v pi >/dev/null 2>&1; then
    echo "pi 已安装: $(pi --version)"
    return
  fi
  echo "安装 pi (官方 installer)..."
  curl -fsSL https://pi.dev/install.sh | sh
  hash -r
  command -v pi >/dev/null 2>&1 || die "pi 安装完成但不在当前 PATH，请重开终端后重跑本脚本"
}

ensure_node() {
  command -v node >/dev/null 2>&1 || die "缺少 node (pi 运行时)，请重开终端后重跑"
}

# 从 --keys-file 读取 KEY=VALUE 的值; 未命中输出空
keys_file_value() { # $1=keys 文件 $2=变量名
  [ -n "$1" ] && [ -r "$1" ] || return 0
  tr -d '\r' < "$1" | awk -F= -v name="$2" '$1 == name { sub(/^[^=]*=/, ""); print; exit }'
}

# $1=provider $2=缺凭据时提示的 env 变量名 $3=可选 --keys-file
# 成功返回 0, 没有任何来源时返回 1 (由调用方决定跳过或中止)
ensure_key() {
  local auth="$HOME/.pi/agent/auth.json"
  local provider="${1}" env_name="${2}" keys_file="${3:-}" key=""
  if [ -f "$auth" ] && [ "$(node -e 'const [f,p]=process.argv.slice(1);let a={};try{a=JSON.parse(require("fs").readFileSync(f,"utf8"))}catch(e){};process.stdout.write(a[p]?"1":"0")' "$auth" "$provider")" = "1" ]; then
    echo "认证已存在 (${provider})"
    return 0
  fi
  key="$(keys_file_value "$keys_file" "$env_name")"
  if [ -z "$key" ]; then
    key="${!env_name:-}"
  fi
  if [ -z "$key" ]; then
    echo "跳过 ${provider}: 缺少凭据 (用 --keys-file 提供 ${env_name}，或设置同名环境变量)"
    return 1
  fi
  printf '%s' "$key" | node -e 'const [f,p]=process.argv.slice(1);const fs=require("fs");let a={};try{a=JSON.parse(fs.readFileSync(f,"utf8"))}catch{};let k="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>k+=c);process.stdin.on("end",()=>{a[p]={type:"api_key",key:k};fs.writeFileSync(f,JSON.stringify(a,null,2)+"\n")})' "$auth" "$provider"
  chmod 600 "$auth"
  echo "已写入 ${provider} 凭据到 ${auth}"
  return 0
}

provider_env_name() {
  case "$1" in
    deepseek) printf 'DEEPSEEK_API_KEY' ;;
    zai) printf 'ZAI_API_KEY' ;;
    trendmicro) printf 'OPENAI_API_KEY' ;;
  esac
}

provider_model() {
  case "$1" in
    deepseek) printf 'deepseek-v4-flash' ;;
    zai) printf 'glm-5.3-flash' ;;
    trendmicro) node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(s.defaultModel)' "$HOME/.pi/agent/settings.json" ;;
  esac
}

provider_profile() {
  case "$1" in
    deepseek) printf 'ds.json' ;;
    zai) printf 'zai.json' ;;
    trendmicro) printf '' ;;
  esac
}

install_packages() {
  local settings="$HOME/.pi/agent/settings.json"
  [ -f "$settings" ] || die "找不到 $settings"
  local packages
  packages="$(node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write((s.packages || []).join("\n"))' "$settings")" \
    || die "解析 settings.json 失败"
  local pkg
  while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    echo "安装 package: $pkg"
    pi install "$pkg"
  done <<< "$packages"
}

# 扩展的外部二进制依赖 (repo 已知清单, 目前仅 rtk): 仅在缺失时用官方 installer 安装。
# installer 自带 SHA-256 校验, 不要设置 RTK_SKIP_CHECKSUM 绕过。失败不中止安装: 扩展会自行禁用。
# $1=install|skip
ensure_ext_bins() {
  [ -f "$HOME/.pi/agent/extensions/rtk.ts" ] || return 0
  if command -v rtk >/dev/null 2>&1; then
    echo "rtk 已安装: $(rtk --version 2>/dev/null | head -1)"
    return 0
  fi
  if [ "$1" = skip ]; then
    echo "(按 --rtk skip 跳过 rtk 安装; 扩展将保持禁用)"
    return 0
  fi
  echo "安装 rtk (官方 installer)..."
  if ! curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh; then
    echo "(rtk 安装失败: 官方 installer 返回非零, 扩展将保持禁用; 可重跑本脚本或手动安装后重试)" >&2
    return 1
  fi
  hash -r 2>/dev/null || true
  if command -v rtk >/dev/null 2>&1; then
    echo "rtk 安装完成: $(rtk --version 2>/dev/null | head -1)"
    return 0
  fi
  echo "(rtk 已装到 ~/.local/bin 但不在当前 PATH; 请把该目录加入 shell 启动文件后重跑, 否则扩展保持禁用)" >&2
  return 1
}

# ponytail 的默认模式只认仓库外的 config 文件, git 同步不到, 因此按 --ponytail-mode 落地。
# 只在 ponytail 已被声明为 package 时写入; 保留文件中其他键; 已有不同值时先备份再改写。
# $1=目标模式 (skip 表示不写)
apply_ponytail_mode() {
  local settings="$HOME/.pi/agent/settings.json"
  local desired="$1" declared dir file current backup
  [ "$desired" = skip ] && return 0
  declared="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((s.packages||[]).some(p=>String(p).includes("ponytail"))?"1":"0")' "$settings" 2>/dev/null || printf '0')"
  [ "$declared" = "1" ] || return 0
  dir="${XDG_CONFIG_HOME:-$HOME/.config}/ponytail"
  file="${dir}/config.json"
  current=""
  if [ -f "$file" ]; then
    current="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).defaultMode||""))}catch(e){process.stdout.write("__unparsable__")}' "$file")"
  fi
  if [ "$current" = "$desired" ]; then
    echo "ponytail 默认模式已是 ${desired}"
    return 0
  fi
  mkdir -p "$dir"
  if [ -f "$file" ]; then
    backup="${file}.bak.$(date +%Y%m%d%H%M%S)"
    cp -p "$file" "$backup" || die "无法备份 ${file}"
    echo "已备份原 ponytail 配置 -> ${backup}"
  fi
  node -e 'const fs=require("fs");const [f,m]=process.argv.slice(1);let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){};c.defaultMode=m;fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' "$file" "$desired"
  echo "已写入 ponytail 默认模式 ${desired} -> ${file}"
}

# $1=provider $2=默认模型 $3=可选 subagents profile 文件名; 写入默认模型并应用 profile 的 subagents 块
apply_model_settings() {
  local settings="$HOME/.pi/agent/settings.json"
  local profile=""
  [ -z "${3:-}" ] || profile="$HOME/.pi/agent/profiles/pi-subagents/${3}"
  [ -z "$profile" ] || [ -f "$profile" ] || die "找不到 ${profile}"
  node -e 'const [f,p,m,pf]=process.argv.slice(1);const fs=require("fs");const s=JSON.parse(fs.readFileSync(f,"utf8"));if(pf){const d=JSON.parse(fs.readFileSync(pf,"utf8"));s.subagents=d.subagents;}s.defaultProvider=p;s.defaultModel=m;fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' \
    "$settings" "$1" "$2" "$profile"
  echo "已应用默认 provider $1 (默认模型 $2${3:+ + $3 subagents profile})"
}

check_settings_clean() {
  [ -z "$(git -C "$HOME/.pi" status --porcelain -- agent/settings.json)" ] && return 0
  die "agent/settings.json 有本地改动，git pull 可能冲突。
  - 丢弃后重跑(推荐, 脚本会按所选 provider 重新写入): git -C ~/.pi checkout -- agent/settings.json
  - 或自行提交/备份后重跑"
}

# 安装 Hindsight client 扩展并把 URL/token 写入 ~/.hindsight/coding-agent.json。
# token 只经 stdin 传给 node, 不进 argv; 也不传给 installer 的命令行。
# $1=API URL $2=token
install_hindsight() {
  local hindsight_url="$1" hindsight_token="$2"
  echo "安装 Hindsight Pi integration..."
  (umask 077 && mkdir -p "$HOME/.hindsight")
  chmod 700 "$HOME/.hindsight"
  if ! npx --yes @vectorize-io/hindsight-coding-agents@0.8.1 install pi --server self-hosted --api-url "$hindsight_url"; then
    die "Hindsight Pi installer 失败"
  fi
  [ ! -f "$HOME/.hindsight/coding-agent.json.hindsight-backup" ] || chmod 600 "$HOME/.hindsight/coding-agent.json.hindsight-backup"
  if ! printf '%s' "$hindsight_token" | node -e 'const fs=require("fs");const [file,url]=process.argv.slice(1);let c={};try{c=JSON.parse(fs.readFileSync(file,"utf8"))}catch(e){};let token="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>token+=x);process.stdin.on("end",()=>{c.serverMode="self-hosted";c.apiUrl=url;c.apiToken=token;delete c.daemonProfile;fs.mkdirSync(require("path").dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,JSON.stringify(c,null,2)+"\n",{mode:0o600});fs.chmodSync(file,0o600)})' "$HOME/.hindsight/coding-agent.json" "$hindsight_url"; then
    die "无法安全写入 Hindsight 客户端配置"
  fi
  chmod 700 "$HOME/.hindsight"
  patch_hindsight_pi_runtime
  echo "已配置 Hindsight endpoint 和认证；请重启 Pi 并运行 hindsight_diagnose 验证连接。"
  echo "注意: 安装器会在首次写入时保存 settings.json.hindsight-backup；切勿用旧备份覆盖当前 Pi settings。"
}

# 官方运行时在 before_agent_start 里直接读 event.prompt, 但 Pi 对该事件同时定义 custom 形态
# (messageType "custom", 由 pi.sendMessage(...,{triggerTurn:true}) 触发), 它没有 prompt 字段,
# 于是抛 TypeError: Cannot read properties of undefined (reading 'trim'), 这一次 run 的记忆注入
# 整体失效。**先探测再打补丁**: 上游修复后本函数自动跳过, 不要无条件改写第三方代码。
# install/update 会覆盖 dist/, 所以每次安装后都要走一遍 (幂等)。探测到未修复才打。
patch_hindsight_pi_runtime() {
  local f="$HOME/.hindsight/coding-agents/dist/pi.js"
  local anchor='      const prompt = event.prompt.trim();'
  [ -f "$f" ] || die "找不到 Hindsight Pi 运行时: $f"
  if grep -qF 'typeof event.prompt === "string"' "$f"; then
    echo "Hindsight Pi 运行时已打过 prompt 兼容补丁。"
    return 0
  fi
  # 探测: 是否存在对 event.prompt 的无守卫使用 (trim/slice/length)。没有就是上游已修复或已改写。
  if ! grep -qE 'event\.prompt\.(trim|slice)\(' "$f"; then
    echo "未探测到 event.prompt 无守卫使用 ($f), 视为上游已处理, 跳过补丁。"
    return 0
  fi
  if ! grep -qF "$anchor" "$f"; then
    echo "警告: 探测到无守卫的 event.prompt 使用, 但锚点已变 ($f); 请人工确认是否仍需兼容补丁。" >&2
    return 0
  fi
  echo "探测到未修复的 event.prompt.trim() (before_agent_start custom 形态会炸), 打兼容补丁..."
  cp -p "$f" "$f.pre-promptguard"
  if ! node -e '
    const fs = require("fs");
    const [file, anchor] = process.argv.slice(1);
    const src = fs.readFileSync(file, "utf8");
    if (src.split(anchor).length !== 2) { console.error("anchor not unique"); process.exit(1); }
    const replacement = [
      "      const rawPrompt = typeof event.prompt === \"string\" ? event.prompt",
      "        : typeof event.message?.content === \"string\" ? event.message.content",
      "        : Array.isArray(event.message?.content) ? event.message.content.filter((part) => part?.type === \"text\").map((part) => part.text).join(\"\\n\")",
      "        : \"\";",
      "      const prompt = rawPrompt.trim();",
    ].join("\n");
    fs.writeFileSync(file, src.replace(anchor, replacement));
  ' "$f" "$anchor"; then
    mv "$f.pre-promptguard" "$f"
    die "Hindsight Pi 运行时补丁失败 (已回滚)"
  fi
  echo "已给 Hindsight Pi 运行时打上 before_agent_start prompt 兼容补丁 (备份: $f.pre-promptguard)。"
}

main() {
  local providers="" default_provider=""
  local keys_file="" hindsight_token_file=""
  local hindsight_url=""
  local rtk_action="install" ponytail_mode="off"
  local provider env_name configured="" seen=""

  # --help 在任何 repo 变更之前处理, 保证只读调用不会触发 pull。
  local arg
  for arg in "$@"; do
    case "$arg" in -h|--help) usage; exit 0 ;; esac
  done

  # 先刷新/克隆 ~/.pi, 再做参数校验: 否则旧 checkout 会按上一版规则拒绝新参数(如零参数)。
  if [ -e "$HOME/.pi" ]; then
    local origin
    origin="$(git -C "$HOME/.pi" remote get-url origin 2>/dev/null || true)"
    if [ -n "$origin" ] && [ "$(repo_slug "$origin")" = "$(repo_slug "$PI_REPO_URL")" ]; then
      ensure_env "$origin"
      check_settings_clean
      echo "刷新 ~/.pi (git pull --ff-only)..."
      local head_before head_after
      head_before="$(git -C "$HOME/.pi" rev-parse HEAD)"
      git -C "$HOME/.pi" pull --ff-only
      head_after="$(git -C "$HOME/.pi" rev-parse HEAD)"
      # 本脚本自身可能刚被更新: 用刷新后的版本重跑一次, 避免旧规则拒绝新参数(已发生过一次)。
      if [ "$head_before" != "$head_after" ] && [ -z "${PI_BOOTSTRAP_REEXEC:-}" ] && [ "$0" -ef "$HOME/.pi/bootstrap.sh" ]; then
        PI_BOOTSTRAP_REEXEC=1 exec "$HOME/.pi/bootstrap.sh" "$@"
      fi
    else
      die "~/.pi 已存在且不是本脚本管理的 repo (${PI_REPO_URL})。
请自行处理(如: mv ~/.pi ~/.pi.bak, 之后可 cp ~/.pi.bak/agent/auth.json ~/.pi/agent/)后重跑。"
    fi
  else
    ensure_env "$PI_REPO_URL"
    echo "clone ${PI_REPO_URL} -> ~/.pi ..."
    git clone "$PI_REPO_URL" "$HOME/.pi"
  fi

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --providers)
        [ "$#" -ge 2 ] || die "--providers 需要逗号分隔的 provider 列表"
        providers="$2"
        shift 2
        ;;
      --default-provider)
        [ "$#" -ge 2 ] || die "--default-provider 需要 provider 名称"
        default_provider="$2"
        shift 2
        ;;
      --keys-file)
        [ "$#" -ge 2 ] || die "--keys-file 需要文件路径"
        keys_file="$2"
        shift 2
        ;;
      --hindsight-api-url)
        [ "$#" -ge 2 ] || die "--hindsight-api-url 需要 URL"
        hindsight_url="$2"
        shift 2
        ;;
      --hindsight-token-file)
        [ "$#" -ge 2 ] || die "--hindsight-token-file 需要文件路径"
        hindsight_token_file="$2"
        shift 2
        ;;
      --rtk)
        [ "$#" -ge 2 ] || die "--rtk 需要 install 或 skip"
        rtk_action="$2"
        shift 2
        ;;
      --ponytail-mode)
        [ "$#" -ge 2 ] || die "--ponytail-mode 需要模式名"
        ponytail_mode="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      -*)
        die "未知参数: $1（--help 查看参数; README 是完整指南）"
        ;;
      *)
        die "未知参数: $1（provider 现在必须写成 --providers $1）"
        ;;
    esac
  done

  case "$rtk_action" in
    install|skip) ;;
    *) die "--rtk 只接受 install 或 skip" ;;
  esac
  case "$ponytail_mode" in
    off|lite|full|ultra|skip) ;;
    *) die "--ponytail-mode 只接受 off|lite|full|ultra|skip" ;;
  esac
  if [ -n "$keys_file" ] && [ ! -r "$keys_file" ]; then
    die "--keys-file 不可读: ${keys_file}"
  fi
  if [ -n "$hindsight_token_file" ] && [ ! -r "$hindsight_token_file" ]; then
    die "--hindsight-token-file 不可读: ${hindsight_token_file}"
  fi

  # 两个 provider 参数都是可选的: 都不给只装 pi + repo 配置, 保留 repo 默认 provider/model。
  if [ -z "$providers" ] && [ -n "$default_provider" ]; then
    providers="$default_provider"
  fi
  if [ -z "$providers" ] && [ -n "$keys_file" ]; then
    die "--keys-file 需要同时指定 --default-provider（或 --providers），否则不知道把凭据写给哪个 provider"
  fi
  local -a selected=()
  if [ -n "$providers" ]; then
    [[ "$providers" != ,* && "$providers" != *, && "$providers" != *,,* ]] || die "provider 列表格式无效: ${providers}"
    IFS=',' read -r -a selected <<< "$providers"
    [ "${#selected[@]}" -gt 0 ] || die "provider 列表不能为空"
    for provider in "${selected[@]}"; do
      case "$provider" in
        deepseek|zai|trendmicro) ;;
        *) die "未知 provider: ${provider} (支持 deepseek,zai,trendmicro)" ;;
      esac
      case ",$seen," in
        *",$provider,"*) die "provider 重复: ${provider}" ;;
      esac
      seen="${seen:+${seen},}${provider}"
    done
    if [ -z "$default_provider" ]; then
      default_provider="${selected[0]}"
    fi
    case ",$seen," in
      *",$default_provider,"*) ;;
      *) die "默认 provider 必须包含在 --providers 列表中" ;;
    esac
  fi

  ensure_pi
  ensure_node
  local model profile
  if [ -n "$providers" ]; then
    env_name="$(provider_env_name "$default_provider")"
    ensure_key "$default_provider" "$env_name" "$keys_file" \
      || die "默认 provider ${default_provider} 没有可用凭据，未应用任何配置"
    configured="$default_provider"
    for provider in "${selected[@]}"; do
      [ "$provider" = "$default_provider" ] && continue
      env_name="$(provider_env_name "$provider")"
      if ensure_key "$provider" "$env_name" "$keys_file"; then
        configured="${configured},${provider}"
      fi
    done
  fi
  echo "安装 settings.json 声明的 packages..."
  install_packages
  ensure_ext_bins "$rtk_action" || echo "(提示: rtk 不可用 (见上方原因), 扩展将在 pi 启动时自行禁用; 其余步骤继续)"
  apply_ponytail_mode "$ponytail_mode"

  if [ -n "$providers" ]; then
    model="$(provider_model "$default_provider")"
    profile="$(provider_profile "$default_provider")"
    apply_model_settings "$default_provider" "$model" "$profile"
    echo "已启用 provider: ${configured}；默认 provider: ${default_provider}"
  else
    echo "未指定 provider：保留 repo 默认 provider/model，未写入任何凭据。"
    echo "需要时：pi auth check --provider <p>，或重跑加 --default-provider <p> --keys-file <file>"
  fi

  if [ -n "$hindsight_url" ]; then
    while [ "${hindsight_url%/}" != "$hindsight_url" ]; do hindsight_url="${hindsight_url%/}"; done
    node -e 'const u=new URL(process.argv[1]);if((u.protocol!=="https:"&&!(u.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(u.hostname)))||u.username||u.password||u.search||u.hash)process.exit(1)' "$hindsight_url" \
      || die "Hindsight URL 必须使用 HTTPS；HTTP 仅允许本机 loopback（如 SSH tunnel）"
    local hindsight_token=""
    if [ -n "$hindsight_token_file" ]; then
      hindsight_token="$(head -n 1 "$hindsight_token_file" | tr -d '\r\n')"
    fi
    if [ -z "$hindsight_token" ]; then
      hindsight_token="${HINDSIGHT_API_TOKEN:-}"
    fi
    [ -n "$hindsight_token" ] || die "缺少 Hindsight token：用 --hindsight-token-file <file> 或 HINDSIGHT_API_TOKEN"
    install_hindsight "$hindsight_url" "$hindsight_token"
    unset hindsight_token
  fi

  echo "---- 自检 ----"
  local f pony pony_mode
  for f in agent/AGENTS.md agent/settings.json agent/models.json; do
    [ -f "$HOME/.pi/$f" ] && echo "✓ $f" || echo "✗ 缺少 $f"
  done
  if [ -f "$HOME/.pi/agent/extensions/rtk.ts" ]; then
    if command -v rtk >/dev/null 2>&1; then
      echo "✓ rtk $(rtk --version 2>/dev/null | head -1)"
    else
      echo "✗ rtk 二进制缺失或不在 PATH (扩展保持禁用)"
    fi
  fi
  pony="${XDG_CONFIG_HOME:-$HOME/.config}/ponytail/config.json"
  if [ -f "$pony" ]; then
    pony_mode="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).defaultMode||""))}catch(e){process.stdout.write("?")}' "$pony")"
    echo "✓ ponytail defaultMode=${pony_mode}"
  fi
  if [ -f "$HOME/.hindsight/coding-agent.json" ]; then
    echo "✓ Hindsight client: $(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).apiUrl||""))}catch(e){process.stdout.write("?")}' "$HOME/.hindsight/coding-agent.json")"
  fi
  pi list
  if [ -n "$providers" ]; then
    echo "完成。provider: ${configured} (默认: ${default_provider})。运行 pi 开始使用。"
  else
    echo "完成。未配置 provider。运行 pi 开始使用，或重跑加 --default-provider <p> --keys-file <file>。"
  fi
}

main "$@"
