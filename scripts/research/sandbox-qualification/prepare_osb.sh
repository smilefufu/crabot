#!/usr/bin/env bash
# Guest-only preparation. All dependency work and server execution enter the
# already prepared infrastructure slice. No package manager or Docker setup.
set -euo pipefail
umask 077

task_root= source_root= manifest= execd_image= egress_image= port= uv_bin=
while (($#)); do
  case "$1" in
    --root) task_root=$2; shift 2 ;;
    --source) source_root=$2; shift 2 ;;
    --manifest) manifest=$2; shift 2 ;;
    --execd-image) execd_image=$2; shift 2 ;;
    --egress-image) egress_image=$2; shift 2 ;;
    --port) port=$2; shift 2 ;;
    --uv) uv_bin=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ $(uname -s) != Linux || $EUID != 0 || -z $task_root || -z $source_root || -z $manifest || -z $uv_bin || -z $port ]]; then
  echo "requires Linux guest root and --root --source --manifest --execd-image --egress-image --port --uv" >&2
  exit 2
fi
[[ $task_root == /* && $task_root != / && $task_root != *:* && $task_root != *%* && $task_root != *$'\n'* && $task_root != *$'\r'* ]] || { echo "invalid task root" >&2; exit 2; }
[[ -d $task_root && ! -L $task_root && $(realpath -e -- "$task_root") == "$task_root" ]] || { echo "task root must be a canonical real directory" >&2; exit 2; }
[[ $(stat -c %u "$task_root") == 0 ]] || { echo "task root must be root-owned" >&2; exit 2; }
(( (8#$(stat -c %a "$task_root") & 0022) == 0 )) || { echo "task root must not be group/world writable" >&2; exit 2; }
marker=$task_root/.guest-authorization
[[ -f $marker && ! -L $marker && $(stat -c '%u:%a' "$marker") == 0:600 ]] || { echo "missing private guest authorization marker" >&2; exit 2; }
[[ $(cat "$marker") == "$(printf 'crabot-sandbox-qualification-phase1\n%s' "$(cat /etc/machine-id)")" ]] || { echo "guest authorization does not match this machine" >&2; exit 2; }
[[ $(stat -fc %T /sys/fs/cgroup) == cgroup2fs && -d /run/systemd/system ]] || { echo "systemd and cgroup v2 required" >&2; exit 2; }
for image in "$execd_image" "$egress_image"; do
  if [[ ! $image =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ && ! $image =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "immutable execd/egress image digests are required" >&2; exit 2
  fi
done
[[ $port =~ ^[0-9]+$ && $port -ge 1024 && $port -le 65535 ]] || { echo "invalid port" >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
python3 - "$task_root" "$source_root" "$manifest" "$uv_bin" "$script_dir/prepare_osb.sh" "$script_dir/osb_patch.py" <<'PY'
import stat, sys
from pathlib import Path
root, source = Path(sys.argv[1]), Path(sys.argv[2])
if root not in source.parents or not source.is_dir():
    raise SystemExit("source must be a directory inside the task root")
for value in sys.argv[2:]:
    path = Path(value)
    if not path.is_absolute() or any(char in value for char in ("\n", "\r", "%", ":")):
        raise SystemExit("protected paths must be canonical absolute paths")
    for item in (path, *path.parents):
        mode = item.lstat()
        if stat.S_ISLNK(mode.st_mode) or mode.st_uid != 0 or mode.st_mode & 0o022:
            raise SystemExit("source, manifest, executables and their ancestors must be root-owned and protected")
    if path.resolve() != path:
        raise SystemExit("protected path is not canonical")
for item in source.rglob("*"):
    mode = item.lstat()
    if mode.st_uid != 0 or (not item.is_symlink() and mode.st_mode & 0o022):
        raise SystemExit("source tree must be root-owned and not group/world writable")
    if item.is_symlink() and source not in item.resolve(strict=True).parents:
        raise SystemExit("source symlink must resolve inside the protected source tree")
PY
source_root=$(realpath -e -- "$source_root")
manifest=$(realpath -e -- "$manifest")
uv_bin=$(realpath -e -- "$uv_bin")
for path in "$source_root" "$manifest" "$uv_bin"; do
  [[ $path == "$task_root/"* ]] || { echo "all preparation paths must be inside task root" >&2; exit 2; }
done
[[ -x $uv_bin && -f /sys/fs/cgroup/cgroup.controllers && -f $source_root/server/uv.lock ]] || { echo "guest prerequisites missing" >&2; exit 2; }
readarray -t fields < <(python3 - "$manifest" <<'PY'
import json, os, re, stat, sys
from pathlib import Path
p = Path(sys.argv[1]); st = p.stat()
if st.st_uid != 0 or st.st_mode & 0o077 or not stat.S_ISREG(st.st_mode):
    raise SystemExit("manifest must be root-owned and mode 0600")
d = json.loads(p.read_text())
if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}", d["instance_id"]):
    raise SystemExit("invalid instance id")
if not d["docker_host"].startswith("unix://"):
    raise SystemExit("private Unix Docker socket required")
for item in (d["instance_id"], d["docker_host"], d["roles"]["infrastructure"]["parent"],
             d["roles"]["infrastructure"]["cgroup_path"]):
    if "\n" in item:
        raise SystemExit("invalid manifest value")
    print(item)
PY
)
[[ ${#fields[@]} == 4 ]] || { echo "invalid manifest" >&2; exit 2; }
instance_id=${fields[0]}
docker_host=${fields[1]}
infra_slice=${fields[2]}
infra_cgroup=${fields[3]}
[[ $infra_slice =~ ^[a-zA-Z0-9_-]+\.slice$ ]] || { echo "invalid infrastructure slice" >&2; exit 2; }
actual_cgroup=$(systemctl show --property=ControlGroup --value "$infra_slice")
[[ -n $actual_cgroup && $actual_cgroup == "$infra_cgroup" && -d /sys/fs/cgroup$actual_cgroup ]] || { echo "infrastructure slice mismatch" >&2; exit 2; }
[[ $docker_host == "unix://$task_root/"* ]] || { echo "Docker socket must be task-private" >&2; exit 2; }
export DOCKER_HOST=$docker_host
[[ $(docker info --format '{{.CgroupVersion}}/{{.CgroupDriver}}') == 2/systemd ]] || { echo "Docker cgroup v2/systemd required" >&2; exit 2; }

server_dir=$task_root/osb/$instance_id
mkdir -p "$server_dir/home" "$server_dir/tmp" "$task_root/uv-cache"
chmod 700 "$server_dir" "$server_dir/home" "$server_dir/tmp"
unit=crabot-qualification-osb-$instance_id
if systemctl is-active --quiet "$unit.service"; then
  echo "server already active; explicit stop and recovery review required" >&2; exit 2
fi
run_prepare() {
  systemd-run --quiet --wait --collect --service-type=exec \
    --unit="$unit-prepare" --slice="$infra_slice" \
    --property=MemoryMax=768M --property=TasksMax=128 --property=MemorySwapMax=0 \
    --property=CPUQuota=100% --property=TimeoutStartSec=600s --property=RuntimeMaxSec=600s \
    --property=KillMode=control-group --property=TimeoutStopSec=30s \
    --setenv="UV_CACHE_DIR=$task_root/uv-cache" \
    --setenv="UV_PROJECT_ENVIRONMENT=$task_root/venv/osb" \
    --setenv=UV_PYTHON_DOWNLOADS=never --setenv=UV_NO_PROGRESS=true \
    --setenv="PATH=$task_root/p/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    --setenv="TMPDIR=$server_dir/tmp" --setenv="HOME=$server_dir/home" \
    --setenv="DOCKER_HOST=$docker_host" "$@"
}
run_prepare python3 "$script_dir/osb_patch.py" --source "$source_root"
run_prepare "$uv_bin" sync --frozen --no-dev --python /usr/bin/python3 --project "$source_root/server"
# Digest-pinned preparation only; each pull is separately bounded by the unit.
for role in execd egress; do
  [[ $role == execd ]] && image=$execd_image || image=$egress_image
  if [[ $image == sha256:* ]]; then
    # Offline loads may not retain RepoDigests. A private normalized record
    # binds the native config ID and diff IDs to the fixed official manifest.
    offline_check=$(cat <<'PY'
import json, os, pathlib, stat, subprocess, sys
path, role, image = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
info = path.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
    raise SystemExit("offline image provenance must be private and root-owned")
fixed = {"execd":"sha256:49b717e2c43b242f80bcd350403186ee8ec8a28576b2cb45471b015d5120f28f",
         "egress":"sha256:2741d5fb796ab859a855e99b5255e740e3562fbaaa2a6d85428e2ed6d3eb19e3"}
record = json.loads(path.read_text())[role]
actual = json.loads(subprocess.check_output(["docker","image","inspect",image],text=True))[0]
if (record["source_manifest"] != fixed[role] or record["config_id"] != image
    or actual["Id"] != image or actual["Architecture"] != "arm64" or actual["Os"] != "linux"
    or actual["RootFS"]["Layers"] != record["diff_ids"]):
    raise SystemExit("offline image identity/provenance mismatch")
PY
)
    run_prepare python3 -c "$offline_check" "$task_root/p/image-provenance.json" "$role" "$image"
  else
    run_prepare docker --host "$docker_host" pull "$image"
  fi
done

python3 - "$server_dir" "$port" "$execd_image" "$egress_image" "$task_root" "$instance_id" <<'PY'
import json, secrets, sys
from pathlib import Path
directory = Path(sys.argv[1]); key_path = directory / "api-key"
if not key_path.exists():
    key_path.write_text(secrets.token_urlsafe(32) + "\n"); key_path.chmod(0o600)
key = key_path.read_text().strip()
if len(key) < 32:
    raise SystemExit("invalid existing private API key")
root = Path(sys.argv[5])
allowed = [root / "fixtures", root / "native/workspaces" / sys.argv[6]]
if any(not path.is_dir() or path.resolve() != path for path in allowed):
    raise SystemExit("fixed fixture/workspace directories must already exist without symlinks")
text = f'''[server]
host = "127.0.0.1"
port = {int(sys.argv[2])}
api_key = {json.dumps(key)}
[runtime]
type = "docker"
execd_image = {json.dumps(sys.argv[3])}
[docker]
network_mode = "bridge"
publish_host = "127.0.0.1"
no_new_privileges = true
pids_limit = 384
[storage]
allowed_host_paths = {json.dumps([str(path) for path in allowed])}
[store]
type = "sqlite"
path = {json.dumps(str(directory / "state.db"))}
[log]
level = "WARNING"
[egress]
image = {json.dumps(sys.argv[4])}
mode = "dns+nft"
[secure_runtime]
type = ""
'''
config = directory / "server.toml"; config.write_text(text); config.chmod(0o600)
PY

# Journald is deliberately not used for unbounded server output. The runner
# must include this fixed file in the cumulative 256 MiB evidence/log budget.
log_path=$server_dir/server.log
[[ ! -f $log_path || $(stat -c %s "$log_path") -lt 1048576 ]] || { echo "previous log requires evidence review" >&2; exit 2; }
systemd-run --quiet --service-type=exec --unit="$unit" --slice="$infra_slice" \
  --property=MemoryMax=512M --property=TasksMax=128 --property=MemorySwapMax=0 \
  --property=CPUQuota=100% --property=RuntimeMaxSec=2700s \
  --property=KillMode=control-group --property=TimeoutStopSec=30s \
  --property=LimitFSIZE=16777216 --property="StandardOutput=append:$log_path" \
  --property="StandardError=append:$log_path" --property="WorkingDirectory=$source_root/server" \
  --setenv="DOCKER_HOST=$docker_host" --setenv="CRABOT_OSB_MANIFEST=$manifest" \
  --setenv="HOME=$server_dir/home" --setenv="TMPDIR=$server_dir/tmp" \
  --setenv="PYTHONPATH=$source_root/server" \
  "$task_root/venv/osb/bin/python" -m opensandbox_server.cli --config "$server_dir/server.toml"
for attempt in {1..30}; do
  systemctl is-active --quiet "$unit.service" || { echo "server failed; inspect private server log" >&2; exit 1; }
  if python3 - "$port" <<'PY'
import sys, urllib.request
try:
    with urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/health", timeout=1) as response:
        raise SystemExit(0 if response.status == 200 else 1)
except OSError:
    raise SystemExit(1)
PY
  then
    printf 'OSB instance=%s unit=%s.service endpoint=http://127.0.0.1:%s\n' "$instance_id" "$unit" "$port"
    exit 0
  fi
  sleep 1
done
systemctl stop "$unit.service"
echo "server readiness timed out; service stopped, evidence retained" >&2
exit 1
