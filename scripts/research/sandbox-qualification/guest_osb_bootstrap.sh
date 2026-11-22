#!/usr/bin/env bash
# Explicitly invoked only after route N has stopped. No apt, host setup, or
# existing Docker context. The entire preparation re-enters the infrastructure.
set -euo pipefail
umask 077
fail() { printf 'guest_osb_bootstrap: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Linux && $EUID == 0 && $# -ge 2 ]] || fail 'requires Linux guest root, TASK_ROOT INPUT_DIR'
task_root=$1; input=$2; mode=${3:-prepare}
[[ $task_root == /* && $task_root != / && $task_root != *:* && $task_root != *%* && $task_root != *$'\n'* ]] || fail 'invalid task root'
[[ -d $task_root && ! -L $task_root && $(realpath -e "$task_root") == "$task_root" ]] || fail 'task root must be canonical'
[[ $(stat -c %u "$task_root") == 0 ]] || fail 'task root must be root-owned'
(( (8#$(stat -c %a "$task_root") & 0022) == 0 )) || fail 'task root is writable by other identities'
marker=$task_root/.guest-authorization
[[ -f $marker && ! -L $marker && $(stat -c '%u:%a' "$marker") == 0:600 ]] || fail 'missing guest authorization'
[[ $(cat "$marker") == "$(printf 'crabot-sandbox-qualification-phase1\n%s' "$(cat /etc/machine-id)")" ]] || fail 'authorization machine mismatch'
[[ -f $task_root/native/budgets.json && ! -L $task_root/native/budgets.json ]] || fail 'native budgets must be prepared'
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
input=$(realpath -e -- "$input")
mapfile -t infrastructure < <(python3 - "$task_root/native/budgets.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))["budgets"]["infrastructure"]
print(d["slice"]); print(d["ControlGroup"])
PY
)
[[ ${#infrastructure[@]} == 2 ]] || fail 'invalid infrastructure budget'
infra_slice=${infrastructure[0]}; infra_path=${infrastructure[1]}
[[ $infra_slice =~ ^[a-zA-Z0-9_-]+\.slice$ ]] || fail 'invalid slice'
[[ $(systemctl show -p ControlGroup --value "$infra_slice") == "$infra_path" ]] || fail 'actual infrastructure mismatch'
membership=$(sed -n 's/^0:://p' /proc/self/cgroup)
base=${infra_slice%-infrastructure.slice}
state=$task_root/p
if [[ $mode == _engine ]]; then
  [[ $membership == "$infra_path"/* ]] || fail 'engine must enter infrastructure first'
  # Limit only the log sink. RLIMIT_FSIZE on dockerd also limits image-layer
  # unpacking and cannot be used as a per-log size limit.
  exec "$state/bin/dockerd" --config-file "$state/daemon.json" > >(python3 -c '
import sys
with open(sys.argv[1], "wb", buffering=0) as output:
    while data := sys.stdin.buffer.read1(65536):
        if output.tell() + len(data) > 16777216:
            output.seek(0); output.truncate()
        output.write(data)
' "$state/logs/engine.log") 2>&1
fi
if [[ $mode == prepare ]]; then
  # Route N control/work must be empty before any platform preparation.
  python3 - "$task_root/native/budgets.json" <<'PY'
import json, pathlib, sys
d = json.load(open(sys.argv[1]))["budgets"]
for instance in ("a", "b"):
    for role in ("control", "work", "auxiliary"):
        p = pathlib.Path(d[f"{instance}/{role}"]["cgroup"]) / "cgroup.events"
        if dict(line.split() for line in p.read_text().splitlines()).get("populated") != "0":
            raise SystemExit("route N/previous instance is still populated; no concurrent P preparation")
PY
  if [[ -f $task_root/native/units ]]; then
    while IFS= read -r unit; do
      [[ $unit =~ ^${base}n[0-9a-f]{16}[cr]?\.service$ ]] || fail 'invalid native unit record'
      ! systemctl is-active --quiet "$unit" || fail 'route N still has an active runner; P must wait'
    done < "$task_root/native/units"
  fi
  exec systemd-run --quiet --wait --pipe --collect --unit="${base}p-bootstrap" --slice="$infra_slice" \
    --property=MemoryMax=256M --property=TasksMax=64 --property=MemorySwapMax=0 \
    --property=CPUQuota=100% --property=RuntimeMaxSec=1800s --property=TimeoutStopSec=30s \
    --property=KillMode=control-group -- /bin/bash "$0" "$task_root" "$input" _inside
fi
[[ $mode == _inside && $membership == "$infra_path"/* ]] || fail 'preparation must enter infrastructure first'
for cmd in python3 mkfs.xfs losetup mount mountpoint findmnt blkid systemctl systemd-run sha256sum; do
  command -v "$cmd" >/dev/null || fail "missing prepared guest dependency: $cmd"
done
[[ $(uname -m) == aarch64 ]] || fail 'this fixed payload is arm64 only'
for directory in "$task_root/assets" "$state" "$state/bin" "$state/run" "$state/logs"; do
  [[ ! -L $directory ]] || fail 'task state is a symlink'
  install -d -m 0700 "$directory"
done
# Only these already downloaded archives are accepted. Input is untrusted until
# copied privately and matched against the fixed host-verified SHA-256 values.
python3 - "$input" "$task_root/assets" <<'PY'
import hashlib, os, pathlib, shutil, stat, sys, tarfile
source, target = map(pathlib.Path, sys.argv[1:])
expected = {
 "docker-29.10.0.tgz": "6e5159e8b5615e0c0c2954a2a1a2a12bc65f5d9b603595dba24a10cb367408cd",
 "uv-aarch64-unknown-linux-gnu.tar.gz": "0797542018e541a9288855df555c8077eed06f7a47d206362030480e8ecc9f3d",
 "opensandbox-1.2.1.tar.gz": "3790ea1856f9542b5bb1b3bbd8fb00257b9c0826470ca1318a9a2e4284a2a72d",
}
for name, digest in expected.items():
    path = source / name
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode) or not 1 <= path.stat().st_size <= 268435456:
        raise SystemExit("archive must be a regular input file")
    temporary = target / (name + ".copy")
    with path.open("rb") as src, temporary.open("xb") as dst:
        shutil.copyfileobj(src, dst, 1024 * 1024)
    actual = hashlib.file_digest(temporary.open("rb"), "sha256").hexdigest()
    if actual != digest:
        raise SystemExit("input archive checksum mismatch: " + name)
    os.replace(temporary, target / name)
# assets.json is evidence only; none of its fields grant execution authority.
metadata = source / "assets.json"
if metadata.is_file() and not metadata.is_symlink() and metadata.stat().st_size <= 1048576:
    shutil.copyfile(metadata, target / "assets.json")
PY
# Do not coexist with an unregistered engine, even inside this disposable VM.
[[ ! -e $state/docker.pid ]] || fail 'previous engine state requires explicit cleanup/review'
! pgrep -x dockerd >/dev/null || fail 'another dockerd is already running'
! pgrep -x containerd >/dev/null || fail 'another containerd is already running'
python3 - "$task_root/assets" "$state" <<'PY'
import pathlib, shutil, sys, tarfile
assets, state = map(pathlib.Path, sys.argv[1:])
for archive, directory in (("docker-29.10.0.tgz", "docker-dist"),
                           ("uv-aarch64-unknown-linux-gnu.tar.gz", "uv-dist"),
                           ("opensandbox-1.2.1.tar.gz", "source-dist")):
    destination = state / directory
    if destination.exists():
        raise SystemExit("extraction directory already exists; review before retry")
    destination.mkdir(mode=0o700)
    with tarfile.open(assets / archive) as source:
        source.extractall(destination, filter="data")
for name in ("docker", "dockerd", "containerd", "containerd-shim-runc-v2", "ctr", "runc", "docker-init", "docker-proxy"):
    matches = [p for p in (state / "docker-dist").rglob(name) if p.is_file() and not p.is_symlink()]
    if len(matches) != 1:
        raise SystemExit("unexpected Docker archive structure: " + name)
    shutil.copyfile(matches[0], state / "bin" / name); (state / "bin" / name).chmod(0o755)
uv = list((state / "uv-dist").rglob("uv"))
if len(uv) != 1 or not uv[0].is_file():
    raise SystemExit("unexpected uv archive structure")
shutil.copyfile(uv[0], state / "bin/uv"); (state / "bin/uv").chmod(0o755)
servers = list((state / "source-dist").rglob("server/opensandbox_server/services/docker/container_ops.py"))
if len(servers) != 1:
    raise SystemExit("unexpected OpenSandbox archive structure")
source = servers[0].parents[4]
(state / "source-path").write_text(str(source) + "\n")
PY
export PATH=$state/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $(docker --version) == *'29.10.0'* && $(uv --version) == 'uv 0.13.9'* ]] || fail 'fixed tool version mismatch'
source_root=$(cat "$state/source-path")
image=$state/docker-data.xfs
data_root=$state/docker-data
[[ ! -e $image && ! -e $data_root ]] || fail 'do not format or reuse prior storage implicitly'
(( $(df -B1 --output=avail "$task_root" | tail -1) >= 17179869184 )) || fail 'at least 16 GiB guest free space required'
truncate -s 8589934592 "$image"
chmod 0600 "$image"
[[ -f $image && ! -L $image && $(stat -c '%u:%h:%s' "$image") == 0:1:8589934592 ]] || fail 'new loop image identity mismatch'
mkfs.xfs -q -f -n ftype=1 "$image"
loop=$(losetup --find --show --nooverlap "$image")
printf '%s\n' "$loop" > "$state/loop-device"
[[ $(losetup -n -O BACK-FILE "$loop") == "$image" ]] || fail 'loop backing identity mismatch'
install -d -m 0700 "$data_root"
mount -t xfs -o prjquota,nodev,nosuid "$loop" "$data_root"
[[ $(findmnt -n -o SOURCE --mountpoint "$data_root") == "$loop" && $(findmnt -n -o FSTYPE --mountpoint "$data_root") == xfs ]] || fail 'bounded XFS mount mismatch'
findmnt -n -o OPTIONS --mountpoint "$data_root" | tr ',' '\n' | grep -qx prjquota || fail 'project quota not active'
python3 - "$task_root" "$state" "$infra_slice" <<'PY'
import json, pathlib, sys
root, state, infrastructure = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
config = {"hosts": ["unix://" + str(root / "docker.sock")], "group": "root",
 "data-root": str(state / "docker-data"), "exec-root": str(state / "run"),
 "pidfile": str(state / "docker.pid"), "storage-driver": "overlay2",
 "features": {"containerd-snapshotter": False}, "cgroup-parent": infrastructure,
 "exec-opts": ["native.cgroupdriver=systemd"], "ip": "127.0.0.1",
 "no-new-privileges": True, "log-driver": "local", "log-opts": {"max-size":"1m","max-file":"2"}}
(state / "daemon.json").write_text(json.dumps(config, indent=2) + "\n")
PY
dockerd --validate --config-file "$state/daemon.json"
engine_unit=${base}p-docker
systemd-run --quiet --service-type=exec --unit="$engine_unit" --slice="$infra_slice" \
  --property=MemoryMax=768M --property=TasksMax=256 --property=MemorySwapMax=0 \
  --property=CPUQuota=150% --property=RuntimeMaxSec=2700s --property=TimeoutStopSec=30s \
  --property=KillMode=control-group --property=StandardOutput=null \
  --property=StandardError=null --setenv="PATH=$PATH" \
  /bin/bash "$0" "$task_root" "$input" _engine
export DOCKER_HOST=unix://$task_root/docker.sock
ready=false
for attempt in {1..45}; do
  systemctl is-active --quiet "$engine_unit.service" || fail 'engine failed; private log retained'
  if docker info >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ $ready == true ]] || fail 'private Docker engine readiness timeout'
[[ $(docker info --format '{{.Driver}}/{{.CgroupVersion}}/{{.CgroupDriver}}') == overlay2/2/systemd ]] || fail 'required Docker storage/cgroup qualification failed'
execd_image=docker.io/opensandbox/execd@sha256:6b12d17844ac7167271488302c71934e47f76abb9ddab19ec8529bd1c1c56b23
egress_image=docker.io/opensandbox/egress@sha256:84b98d3b5989a87389c977f6433f8cd3c7998d03aa15aaae41ebcb15b7eb8000
base_image=docker.io/library/python@sha256:c61cffc3bacb94ed026ff8b45d5114b7693dd0420baca0a1ace0e3d0ce9035fd
docker pull "$base_image"
install -m 0444 /etc/machine-id "$task_root/fixtures/machine-id"
install -d -m 0700 "$state/fixture-image"
cat > "$state/fixture-image/Dockerfile" <<EOF
FROM $base_image
ARG FIXTURE_UID
RUN mkdir -p /home/fixture /tmp/qualification && chown "\${FIXTURE_UID}:\${FIXTURE_UID}" /home/fixture /tmp/qualification && chmod 0700 /home/fixture /tmp/qualification
ENV HOME=/home/fixture TMPDIR=/tmp/qualification EXECD_ENVS=/tmp/qualification/execd.env
USER \${FIXTURE_UID}:\${FIXTURE_UID}
WORKDIR /workspace
EOF
# The tiny fixed mkdir/chown fixture is not a product execution bridge. The
# legacy builder gets an explicit parent; do not silently change builder mode.
for instance in a b; do
  [[ $instance == a ]] && uid=62001 || uid=62002
  DOCKER_BUILDKIT=0 docker build --network=none --cgroup-parent "$infra_slice" \
    --memory 268435456 --memory-swap 268435456 --cpu-quota 100000 --cpu-period 100000 \
    --build-arg "FIXTURE_UID=$uid" -t "crabot-qualification-$instance:fixed" "$state/fixture-image"
done
python3 - "$task_root" "$engine_unit" "$base_image" <<'PY'
import json, os, pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1]); budgets = json.loads((root / "native/budgets.json").read_text())["budgets"]
result = {"engine_unit":sys.argv[2]+".service", "docker_host":"unix://"+str(root/"docker.sock"),
          "base_image":sys.argv[3], "instances":{}}
for instance, uid, port in (("a",62001,18001),("b",62002,18002)):
    def role(name, memory, cpus, pids):
        key = "infrastructure" if name == "infrastructure" else f"{instance}/{name}"
        return {"parent":budgets[key]["slice"], "cgroup_path":budgets[key]["ControlGroup"],
                "memory_bytes":memory, "nano_cpus":cpus, "pids":pids}
    manifest = {"instance_id":instance, "docker_host":result["docker_host"], "roles":{
      "work":role("work",1073741824,1750000000,384),
      "auxiliary":role("auxiliary",134217728,250000000,64),
      "infrastructure":role("infrastructure",134217728,250000000,64)}}
    path = root / "p" / (instance+"-manifest.json")
    path.write_text(json.dumps(manifest,indent=2)+"\n"); path.chmod(0o600)
    image = subprocess.check_output([str(root/"p/bin/docker"),"image","inspect","--format","{{.Id}}",f"crabot-qualification-{instance}:fixed"],text=True).strip()
    result["instances"][instance] = {"uid":uid,"port":port,"image":image,"manifest":str(path)}
(root/"p/bootstrap.json").write_text(json.dumps(result,indent=2)+"\n")
PY
# Start both servers while the engine has no OSB sandbox objects. Do not run
# cross-server restore: stock ownership/recovery semantics are outside scope.
for instance in a b; do
  [[ $instance == a ]] && port=18001 || port=18002
  bash "$script_dir/prepare_osb.sh" --root "$task_root" --source "$source_root" \
    --manifest "$state/$instance-manifest.json" --execd-image "$execd_image" \
    --egress-image "$egress_image" --port "$port" --uv "$state/bin/uv"
done
printf 'P preparation ready; registry digests, private engine and instance metadata recorded under task root/p\n'
