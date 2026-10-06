#!/bin/bash
# Linux CI 实际发行包：未修改的旧 CLI 一次升级、两普通 UID、只读资源和退出清理。
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'system audit requires an isolated root CI runner'; exit 1; }
workspace=$1
archive=$2
output=$3
baseline=$4
mkdir -p "$output"
fixture=$(mktemp -d /tmp/crabot-system-audit-XXXXXX)
chmod 0755 "$fixture"  # 普通用户需要穿过安装根的父目录。
cp "$workspace/.github/scripts/smoke-scrapling.mjs" "$workspace/.github/scripts/scrapling-exit-probe.py" "$fixture/"
root=$fixture/install-custom
persons=(crabot-audit-a crabot-audit-b)
cleanup() {
  for person in "${persons[@]}"; do userdel -r "$person" 2>/dev/null || true; done
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir -p "$root" /etc/crabot
printf '1\n' >/etc/crabot/cluster.version
# baseline 只含原始 CLI/helper；升级前未放入候选环境。
tar -xf "$baseline" -C "$root"
printf 'v2026.9.23\n' > "$root/VERSION"
mkdir "$root/.scrapling-runtime-retained-old"
printf 'keep\n' > "$root/.scrapling-runtime-retained-old/sentinel"
for person in "${persons[@]}"; do
  useradd -m -s /bin/bash "$person"
  off=10; enabled=false
  if [ "$person" = crabot-audit-b ]; then off=20; enabled=true; fi
  dir=/home/$person/.crabot/data-$off/admin
  mkdir -p "$dir"
  printf '{"mode":"system","port_offset":%s}\n' "$off" > /home/$person/.crabot/instance.json
  printf '[{"id":"existing-scrapling","name":"scrapling","command":"scrapling","args":["mcp"],"transport":"stdio","enabled":%s,"is_builtin":true},{"id":"custom","name":"custom","command":"custom-command","args":[],"enabled":true}]\n' "$enabled" > "$dir/mcp-servers.json"
  chown -R "$person:$person" /home/$person/.crabot
done
find /home/crabot-audit-a/.crabot /home/crabot-audit-b/.crabot "$root/.scrapling-runtime-retained-old" -type f -exec sha256sum '{}' \; > "$output/preserved.sha256"
sha256sum "$root/cli.mjs" "$root/scripts/upgrade.mjs" > "$output/old-entry.sha256"
export CRABOT_AUDIT_ARCHIVE=$archive
export CRABOT_AUDIT_SHA=$archive.sha256
export DATA_DIR=$fixture/root-data
export UV_PYTHON=3.12
export UV_CACHE_DIR=$fixture/uv-cache
export NODE_OPTIONS=--import=$workspace/.github/scripts/scrapling-upgrade-fetch.mjs
node "$root/cli.mjs" upgrade -y | tee "$output/upgrade.log"
unset NODE_OPTIONS DATA_DIR
sha256sum -c "$output/preserved.sha256"
[ "$(cat "$root/VERSION")" = v2099.1.1-system-audit ]
"$root/crabot-memory/.venv/bin/python" -c 'import fastapi,openai,anthropic,aiosqlite; print("REAL_MEMORY_SYNC_PASSED")'
runtime=$(node -p "require('$root/scrapling-runtime.json').directory")
chmod -R a-w "$root"
for person in "${persons[@]}"; do
  # 仅记录路径变量，避免输出 runner 环境中的凭据。
  su -s /bin/bash -c 'for key in HOME XDG_CONFIG_HOME CHROME_CONFIG_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR; do printf "%s=%s\n" "$key" "${!key-}"; done' "$person" | tee "$output/$person-paths.log"
  # 未经入口修正的 Chromium 对照，保留普通 UID 的原始启动错误。
  su -s /bin/bash -c "timeout 20 '$root/$runtime/chromium-launcher' --headless --no-sandbox --dump-dom --user-data-dir='/home/$person/chrome-probe' 'data:text/html,<p>probe</p>'" "$person" > "$output/$person-native-browser.log" 2>&1 || true
  for run in cold warm; do
    log=$output/$person-$run.log
    su -s /bin/bash -c "PATH='$PATH' CRABOT_KEEP_SMOKE_ARTIFACTS=1 node '$fixture/smoke-scrapling.mjs' '$root'" "$person" > "$log" 2>&1 || { cat "$log"; exit 1; }
    artifact=$(node -e 'const fs=require("fs"); const line=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").findLast(l=>l.startsWith("{\"result\"")); console.log(JSON.parse(line).screenshots)' "$log")
    cp "$artifact/dynamic.png" "$output/$person-$run-dynamic.png"
    cp "$artifact/stealthy.png" "$output/$person-$run-stealthy.png"
    rm -rf "$artifact"
  done
  su -s /bin/bash -c "DATA_DIR=/home/$person/.crabot/exit-data '$root/$runtime/python-launcher' '$fixture/scrapling-exit-probe.py' '$root/$runtime'" "$person" | tee "$output/$person-exit.log"
  cp /home/$person/.crabot/exit-data/exit-result.json "$output/$person-exit.json"
  su -s /bin/bash -c "PATH='$PATH' node '$root/scripts/prepare-scrapling.mjs' --check && test ! -w '$root/$runtime/server.py'" "$person"
done
sha256sum -c "$output/preserved.sha256"
printf 'ONE_OLD_UPGRADE_REAL_MEMORY_TWO_USERS_AND_HEADLESS_PASSED\n'
