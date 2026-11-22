#!/usr/bin/env bash
# Guest-only first-stage qualification. No host setup, account creation or apt install.
# Usage: sudo bash native_route.sh TASK_ROOT prepare|build|paths|cleanup
#        sudo bash native_route.sh TASK_ROOT run a|b control|work|auxiliary -- ARGV...
# Bootstrap must create TASK_ROOT/.guest-authorization (root:root, 0600):
#   crabot-sandbox-qualification-phase1\n<contents of /etc/machine-id>\n
# Work argv uses /fixtures and /workspace (/work is the same bounded volume);
# control argv uses ordinary guest paths.
# prepare creates bounded ext4 work images; cleanup stops only this runner's units.
set -euo pipefail
umask 077

fail() { printf 'native_route: %s\n' "$*" >&2; exit 1; }
[[ $# -ge 2 ]] || fail 'TASK_ROOT and operation are required'
[[ $(uname -s) == Linux && $EUID == 0 ]] || fail 'requires the authorized Linux guest and root'
TASK_ROOT=$1; OP=$2; shift 2
[[ $TASK_ROOT == /* && $TASK_ROOT != / && $TASK_ROOT != *:* && $TASK_ROOT != *$'\n'* ]] || fail 'invalid task root'
[[ $TASK_ROOT != *%* && $TASK_ROOT != *$'\r'* ]] || fail 'unsupported systemd path characters'
[[ -d $TASK_ROOT && ! -L $TASK_ROOT && $(realpath -e -- "$TASK_ROOT") == "$TASK_ROOT" ]] || fail 'task root must be a canonical real directory'
[[ $(stat -c %u "$TASK_ROOT") == 0 ]] || fail 'task root is not root-owned'
(( (8#$(stat -c %a "$TASK_ROOT") & 0022) == 0 )) || fail 'task root must not be group/world writable'
MARKER=$TASK_ROOT/.guest-authorization
[[ -f $MARKER && ! -L $MARKER && $(stat -c '%u:%a' "$MARKER") == 0:600 ]] || fail 'missing private guest authorization marker'
[[ $(cat "$MARKER") == "$(printf 'crabot-sandbox-qualification-phase1\n%s' "$(cat /etc/machine-id)")" ]] || fail 'guest authorization does not match this machine'
[[ $(stat -fc %T /sys/fs/cgroup) == cgroup2fs && -d /run/systemd/system ]] || fail 'requires systemd and cgroup v2'
SELF=$(realpath -e -- "${BASH_SOURCE[0]}")
[[ $(stat -c %u "$SELF") == 0 ]] || fail 'guest runner must be installed root-owned'
(( (8#$(stat -c %a "$SELF") & 0022) == 0 )) || fail 'guest runner must not be group/world writable'
KEY=$(printf '%s' "$TASK_ROOT" | sha256sum | cut -c1-12)
BASE=cq${KEY}
STATE=$TASK_ROOT/native
NSJAIL_COMMIT=f78475530b46d0186111a9096b30725f816b55fe
[[ ! -L $STATE ]] || fail 'native state cannot be a symbolic link'

unit_for() {
  case $1 in
    platform) printf '%s.slice' "$BASE" ;;
    infrastructure) printf '%s-infrastructure.slice' "$BASE" ;;
    a|b) printf '%s-%s.slice' "$BASE" "$1" ;;
    a/*|b/*) printf '%s-%s-%s.slice' "$BASE" "${1%/*}" "${1#*/}" ;;
    *) fail 'invalid budget role' ;;
  esac
}
cg_for() {
  local cg
  cg=$(systemctl show --property=ControlGroup --value "$(unit_for "$1")")
  [[ $cg == /"$BASE".slice* && -d /sys/fs/cgroup$cg ]] || fail "missing budget: $1"
  printf '/sys/fs/cgroup%s' "$cg"
}
check_budget() {
  local role=$1 memory=$2 tasks=$3 cg
  cg=$(cg_for "$role")
  [[ $(cat "$cg/memory.max") == "$memory" && $(cat "$cg/pids.max") == "$tasks" && $(cat "$cg/memory.swap.max") == 0 ]] || fail "budget mismatch: $role"
  [[ $(stat -c %u "$cg") == 0 ]] || fail "budget owner mismatch: $role"
  (( (8#$(stat -c %a "$cg") & 0022) == 0 )) || fail "budget writable by work: $role"
}
check_all() {
  check_budget platform 9663676416 2048
  check_budget infrastructure 2147483648 512
  [[ $(cat "$(cg_for platform)/cpu.max") == '250000 100000' ]] || fail 'platform CPU cap mismatch'
  local instance
  for instance in a b; do
    check_budget "$instance" 3758096384 768
    [[ $(cat "$(cg_for "$instance")/cpu.max") == '175000 100000' ]] || fail "instance CPU cap mismatch: $instance"
    check_budget "$instance/control" 2147483648 320
    check_budget "$instance/work" 1073741824 384
    check_budget "$instance/auxiliary" 134217728 64
  done
}
set_budget() {
  local role=$1 memory=$2 tasks=$3 quota=${4:-} unit cg
  unit=$(unit_for "$role")
  systemctl start "$unit"
  local props=(MemoryAccounting=yes CPUAccounting=yes TasksAccounting=yes "MemoryMax=$memory" MemorySwapMax=0 "TasksMax=$tasks" CPUWeight=100)
  [[ -z $quota ]] || props+=("CPUQuota=$quota" CPUQuotaPeriodSec=100ms)
  systemctl set-property --runtime "$unit" "${props[@]}"
  cg=$(cg_for "$role")
  printf '%s\n' 0 > "$cg/memory.oom.group"
  [[ $role != */work ]] || printf '%s\n' 1 > "$cg/memory.oom.group"
}
record_unit() {
  local unit=$1
  [[ $unit =~ ^${BASE}n[0-9a-f]{16}[cr]?\.service$ ]] || fail 'invalid native unit identity'
  (flock -x 9; printf '%s\n' "$unit" >&9) 9>> "$STATE/units"
}
paths() {
  python3 - "$TASK_ROOT" "$BASE" <<'PY'
import json, subprocess, sys
root, base = sys.argv[1:]
roles = ['platform', 'infrastructure', 'a', 'a/control', 'a/work', 'a/auxiliary', 'b', 'b/control', 'b/work', 'b/auxiliary']
result = {'task_root': root, 'network': 'private netns; no positive egress configured', 'budgets': {}}
for role in roles:
    unit = base + ('' if role == 'platform' else '-' + role.replace('/', '-')) + '.slice'
    group = subprocess.check_output(['systemctl', 'show', '--property=ControlGroup', '--value', unit], text=True).strip()
    result['budgets'][role] = {'slice': unit, 'ControlGroup': group, 'cgroup': '/sys/fs/cgroup' + group}
for name in ['a', 'b']:
    result.setdefault('instances', {})[name] = {'workspace': root + '/native/workspaces/' + name, 'fixtures': root + '/fixtures', 'control': root + '/native/control/' + name}
print(json.dumps(result, indent=2))
PY
}
prepare() {
  for cmd in python3 systemctl systemd-run flock mount mountpoint findmnt losetup mkfs.ext4 sha256sum getent setpriv; do command -v "$cmd" >/dev/null || fail "missing dependency: $cmd"; done
  # Control, human and work use the same synthetic host UID per instance.
  # Traverse-only parents make its 0700 workspace reachable by the human UID;
  # work sees only the explicit volume mounts, not the task/control directories.
  chmod 0711 "$TASK_ROOT"
  local relative
  for relative in native/config native/jails native/volumes native/workspaces native/logs native/bin native/src native/control; do
    [[ ! -L $TASK_ROOT/$relative ]] || fail "task directory cannot be a symbolic link: $relative"
  done
  install -d -m 0711 "$STATE" "$STATE/control" "$STATE/workspaces" "$STATE/jails"
  install -d -m 0700 "$STATE/config" "$STATE/volumes" "$STATE/logs" "$STATE/bin" "$STATE/src"
  [[ -e $TASK_ROOT/fixtures ]] || install -d -m 0755 "$TASK_ROOT/fixtures"
  [[ -d $TASK_ROOT/fixtures && ! -L $TASK_ROOT/fixtures ]] || fail 'invalid fixtures directory'
  [[ -z $(find "$TASK_ROOT/fixtures" \( ! -user root -o -perm /022 \) -print -quit) ]] || fail 'fixtures must be root-owned and not group/world writable'
  install -m 0444 "$MARKER" "$TASK_ROOT/fixtures/.guest-authorization"
  set_budget platform 9663676416 2048 250%
  set_budget infrastructure 2147483648 512
  local instance index control_uid aux_uid image target loop
  for instance in a b; do
    [[ $instance == a ]] && index=1 || index=2
    control_uid=$((62000 + index)); aux_uid=$((62020 + index))
    for uid in "$control_uid" "$aux_uid"; do
      ! getent passwd "$uid" >/dev/null || fail "synthetic UID already belongs to an account: $uid"
      ! getent group "$uid" >/dev/null || fail "synthetic GID already belongs to a group: $uid"
    done
    set_budget "$instance" 3758096384 768 175%
    set_budget "$instance/control" 2147483648 320
    set_budget "$instance/work" 1073741824 384
    set_budget "$instance/auxiliary" 134217728 64
    install -d -m 0700 -o "$control_uid" -g "$control_uid" "$STATE/control/$instance"
    install -d -m 0755 "$STATE/jails/$instance" "$STATE/workspaces/$instance"
    for dir in usr bin lib lib64 fixtures work workspace proc tmp run dev dev/shm etc; do
      install -d -m 0755 "$STATE/jails/$instance/$dir"
    done
    for file in dev/null dev/zero dev/random dev/urandom etc/ld.so.cache etc/machine-id; do
      touch "$STATE/jails/$instance/$file"
      chmod 0444 "$STATE/jails/$instance/$file"
    done
    [[ -e $STATE/jails/$instance/dev/fd || -L $STATE/jails/$instance/dev/fd ]] || ln -s /proc/self/fd "$STATE/jails/$instance/dev/fd"
    image=$STATE/volumes/$instance.ext4; target=$STATE/workspaces/$instance
    if [[ ! -e $image ]]; then
      truncate -s 1073741824 "$image"
      mkfs.ext4 -q -F -m 0 "$image"
    fi
    [[ -f $image && ! -L $image && $(stat -c '%u:%s' "$image") == 0:1073741824 ]] || fail 'invalid bounded work image'
    if mountpoint -q "$target"; then
      loop=$(findmnt -n -o SOURCE --mountpoint "$target")
      [[ $(losetup -n -O BACK-FILE "$loop") == "$image" ]] || fail 'work mount belongs to another backing file'
    else
      mount -o loop,nodev,nosuid "$image" "$target"
    fi
    [[ $(findmnt -n -o FSTYPE --mountpoint "$target") == ext4 ]] || fail 'work volume is not the bounded ext4 filesystem'
    chown "$control_uid:$control_uid" "$target"; chmod 0700 "$target"
  done
  write_helpers
  check_all
  paths > "$STATE/budgets.json"
  cat "$STATE/budgets.json"
}
write_helpers() {
  python3 - "$TASK_ROOT" <<'PY'
import json, os, pathlib, platform, sys
root = pathlib.Path(sys.argv[1]); state = root / 'native'
# Kafel's ARM64 table calls the umount2 kernel operation "umount".
unmount = 'umount' if platform.machine() in ('aarch64', 'arm64') else 'umount2'
def mount(src, dst, rw=False, directory=True, **extra):
    data = dict(src=str(src), dst=dst, is_bind=True, rw=rw, is_dir=directory, nosuid=True, nodev=not dst.startswith('/dev/'))
    data.update(extra)
    return 'mount { ' + ' '.join(k + ': ' + (str(v).lower() if isinstance(v, bool) else json.dumps(v)) for k,v in data.items()) + ' }'
for name, uid in [('a', 62001), ('b', 62002)]:
    lines = ['mode: ONCE', 'hostname: "qualification-work"', 'cwd: "/work"', 'time_limit: 40',
             'nice_level: 0', 'keep_env: false', 'keep_caps: false', 'disable_no_new_privs: false',
             'clone_newnet: true', 'clone_newuser: true', 'clone_newns: true', 'clone_newpid: true',
             'clone_newipc: true', 'clone_newuts: true', 'clone_newcgroup: true',
             'rlimit_as_type: HARD', 'rlimit_cpu: 40', 'rlimit_fsize: 1280', 'rlimit_nofile: 1024', 'rlimit_nproc_type: HARD',
             'envar: "PATH=/usr/bin:/bin"', 'envar: "HOME=/tmp"', 'envar: "LANG=C.UTF-8"', 'envar: "TMPDIR=/tmp"',
             f'uidmap {{ inside_id: "1000" outside_id: "{uid}" count: 1 }}',
             f'gidmap {{ inside_id: "1000" outside_id: "{uid}" count: 1 }}',
             mount(state / 'jails' / name, '/')]
    for path in ['/usr', '/bin', '/lib', '/lib64']:
        if os.path.exists(path): lines.append(mount(path, path))
    for path in ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/etc/ld.so.cache', '/etc/machine-id']:
        if os.path.exists(path): lines.append(mount(path, path, directory=False))
    lines += [mount(root / 'fixtures', '/fixtures'), mount(state / 'workspaces' / name, '/work', rw=True), mount(state / 'workspaces' / name, '/workspace', rw=True),
              'mount { dst: "/proc" fstype: "proc" is_dir: true rw: false nosuid: true nodev: true noexec: true }']
    for path, size in [('/tmp', 67108864), ('/run', 4194304), ('/dev/shm', 67108864)]:
        lines.append('mount { dst: ' + json.dumps(path) + ' fstype: "tmpfs" options: "size=' + str(size) + ',mode=1777" is_dir: true rw: true nosuid: true nodev: true }')
    lines.append('seccomp_string: "ERRNO(1) { mount, ' + unmount + ', pivot_root, setns, unshare, ptrace, process_vm_readv, process_vm_writev, bpf, perf_event_open, userfaultfd, keyctl, add_key, request_key } DEFAULT ALLOW"')
    (state / 'config' / (name + '.cfg')).write_text('\n'.join(lines) + '\n')
PY
  cat > "$STATE/bounded_run.py" <<'PY'
#!/usr/bin/env python3
"""Trusted infrastructure runner; work never sees this file or its state."""
import json, os, pathlib, selectors, signal, subprocess, sys, time
root, unit, slice_name, role, instance, *argv = sys.argv[1:]
state = pathlib.Path(root) / 'native'
props = ['--property=KillMode=control-group', '--property=TimeoutStopSec=5s', '--property=RuntimeMaxSec=45s']
if role == 'work':
    command = [str(state / 'bin/nsjail'), '--config', str(state / 'config' / (instance + '.cfg')), '--', *argv]
else:
    index = 1 if instance == 'a' else 2
    uid = (62000 if role == 'control' else 62020) + index
    props += ['--property=NoNewPrivileges=yes', '--property=PrivateTmp=yes', '--property=PrivateNetwork=yes', '--property=ProtectHome=yes', '--property=ProtectControlGroups=yes']
    if role == 'control': props += ['--property=WorkingDirectory=' + str(state / 'control' / instance)]
    # The synthetic numeric UID deliberately has no NSS account. Drop privilege
    # after PID1 has entered the budget, without creating or borrowing an account.
    command = ['/usr/bin/setpriv', f'--reuid={uid}', f'--regid={uid}', '--clear-groups', '--bounding-set=-all', '--no-new-privs', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', *argv]
args = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--unit=' + unit, '--slice=' + slice_name, *props, '--', *command]
proc = subprocess.Popen(args, stdin=sys.stdin.buffer, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
selector = selectors.DefaultSelector(); handles = {}; counts = {'stdout': 0, 'stderr': 0}
for name in counts:
    stream = getattr(proc, name); os.set_blocking(stream.fileno(), False)
    selector.register(stream, selectors.EVENT_READ, name)
    handles[name] = open(state / 'logs' / (unit + '.' + name), 'xb')
reason = None; started = time.monotonic(); stopping = False; code = 125; runner_error = None
control_group = None; cleanup = 'unknown'; service_properties = {}
def interrupted(_signum, _frame):
    raise KeyboardInterrupt('runner interrupted')
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    while selector.get_map():
        if control_group is None:
            observed = subprocess.run(['systemctl', 'show', '--property=ControlGroup,RuntimeMaxUSec,MainPID,Slice', unit], capture_output=True, text=True, timeout=5).stdout
            properties = dict(line.split('=', 1) for line in observed.splitlines() if '=' in line)
            if properties.get('ControlGroup'):
                control_group = properties['ControlGroup']; service_properties = properties
        if not stopping and time.monotonic() - started > 55:
            reason = 'watchdog'; stopping = True
            subprocess.run(['systemctl', 'kill', '--kill-whom=all', '--signal=KILL', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            subprocess.run(['systemctl', 'stop', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        for key, _ in selector.select(0.1):
            data = os.read(key.fileobj.fileno(), 65536)
            if not data:
                selector.unregister(key.fileobj); key.fileobj.close(); continue
            name = key.data; remaining = max(0, 1048576 - counts[name]); handles[name].write(data[:remaining]); counts[name] += len(data)
            if counts[name] > 1048576 and not stopping:
                reason = 'output_limit'; stopping = True
                subprocess.run(['systemctl', 'kill', '--kill-whom=all', '--signal=KILL', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
                subprocess.run(['systemctl', 'stop', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        if stopping and time.monotonic() - started > 75:
            raise RuntimeError('cleanup unknown: captured command streams remain open')
    code = proc.wait(timeout=10)
except (KeyboardInterrupt, OSError, subprocess.SubprocessError, RuntimeError) as error:
    reason = reason or 'runner_error'
    runner_error = type(error).__name__
finally:
    for handle in handles.values(): handle.close()
    selector.close()
    try:
        subprocess.run(['systemctl', 'stop', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12)
        active = subprocess.run(['systemctl', 'is-active', '--quiet', unit], timeout=5).returncode == 0
        empty = True
        if control_group:
            events = pathlib.Path('/sys/fs/cgroup' + control_group) / 'cgroup.events'
            if events.exists():
                empty = dict(line.split() for line in events.read_text().splitlines()).get('populated') == '0'
        cleanup = 'complete' if not active and empty else 'unknown'
    except (OSError, subprocess.TimeoutExpired):
        cleanup = 'unknown'
result = {'unit': unit, 'role': role, 'instance': instance, 'control_group': control_group, 'service_properties': service_properties, 'returncode': code, 'termination': reason, 'runner_error': runner_error, 'cleanup': cleanup, 'output_bytes': counts, 'logs': {name: str(state / 'logs' / (unit + '.' + name)) for name in counts}}
print(json.dumps(result), flush=True)
sys.exit(125 if cleanup != 'complete' else 124 if reason else (code if 0 <= code <= 255 else 1))
PY
  chmod 0600 "$STATE/bounded_run.py"
}
build() {
  check_all
  local unit=${BASE}n$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')r.service
  record_unit "$unit"
  systemd-run --quiet --wait --pipe --collect --unit="$unit" --slice="$(unit_for infrastructure)" \
    --property=RuntimeMaxSec=900s --property=TimeoutStopSec=10s --property=KillMode=control-group \
    -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 /bin/bash "$SELF" "$TASK_ROOT" _build
}
build_inner() {
  local cmd src=$STATE/src/nsjail membership infrastructure
  check_all
  membership=$(sed -n 's/^0:://p' /proc/self/cgroup)
  infrastructure=$(systemctl show --property=ControlGroup --value "$(unit_for infrastructure)")
  [[ $membership == "$infrastructure"/* ]] || fail 'build must enter the infrastructure budget before executing'
  for cmd in git make gcc g++ protoc pkg-config bison flex; do command -v "$cmd" >/dev/null || fail "missing build dependency: $cmd"; done
  pkg-config --exists protobuf libnl-route-3.0 || fail 'missing protobuf or libnl-route development packages'
  if [[ ! -d $src ]]; then
    git -c protocol.file.allow=never -c protocol.ext.allow=never clone --branch 3.6 --depth 1 https://github.com/google/nsjail.git "$src"
  fi
  [[ $(git -C "$src" rev-parse HEAD) == "$NSJAIL_COMMIT" ]] || fail 'NsJail 3.6 commit mismatch'
  git -C "$src" diff --exit-code --quiet || fail 'NsJail tracked source was changed'
  git -C "$src" -c protocol.file.allow=never -c protocol.ext.allow=never submodule update --init --recursive
  make -C "$src" -j2
  install -m 0755 "$src/nsjail" "$STATE/bin/nsjail"
  {
    printf 'release=3.6\ncommit=%s\n' "$NSJAIL_COMMIT"
    sha256sum "$STATE/bin/nsjail"
    git -C "$src" submodule status --recursive
    g++ --version
  } > "$STATE/nsjail-build.txt"
  cat "$STATE/nsjail-build.txt"
}
run() {
  [[ $# -ge 4 && $3 == -- ]] || fail 'run requires a|b role -- argv'
  local instance=$1 role=$2; shift 3
  [[ $instance == a || $instance == b ]] || fail 'invalid instance'
  [[ $role == control || $role == work || $role == auxiliary ]] || fail 'invalid role'
  [[ $1 == /* ]] || fail 'fixture executable must be absolute'
  check_all
  [[ $role != work || -x $STATE/bin/nsjail ]] || fail 'build the pinned NsJail first'
  [[ -f $STATE/bounded_run.py && ! -L $STATE/bounded_run.py ]] || fail 'prepare first'
  (( $(du -sb "$STATE/logs" | cut -f1) <= 266338304 )) || fail 'native log budget exhausted'
  local id unit runner
  id=$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')
  unit=${BASE}n${id}c.service; runner=${BASE}n${id}r.service
  record_unit "$unit"; record_unit "$runner"
  systemd-run --quiet --wait --pipe --collect --unit="$runner" --slice="$(unit_for infrastructure)" \
    --property=RuntimeMaxSec=90s --property=TimeoutStopSec=5s --property=KillMode=control-group \
    -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 /usr/bin/python3 "$STATE/bounded_run.py" "$TASK_ROOT" "$unit" "$(unit_for "$instance/$role")" "$role" "$instance" "$@"
}
cleanup() {
  [[ -f $STATE/units && ! -L $STATE/units ]] || return 0
  local unit status=0 load_state group platform_cgroup=/sys/fs/cgroup/$BASE.slice
  while IFS= read -r unit; do
    [[ $unit =~ ^${BASE}n[0-9a-f]{16}[cr]?\.service$ ]] || fail 'invalid recorded unit; cleanup unknown'
    load_state=$(systemctl show --property=LoadState --value "$unit" 2>/dev/null || true)
    [[ -n $load_state ]] || { printf 'native_route: unit state unknown: %s\n' "$unit" >&2; status=1; }
    if [[ $load_state != not-found && -n $load_state ]]; then
      systemctl stop "$unit" || status=1
    fi
    if systemctl is-active --quiet "$unit"; then printf 'native_route: unit still active: %s\n' "$unit" >&2; status=1; fi
    if [[ -d $platform_cgroup ]]; then
      while IFS= read -r group; do
        [[ $(sed -n 's/^populated //p' "$group/cgroup.events") == 0 ]] || { printf 'native_route: populated native cgroup remains: %s\n' "$group" >&2; status=1; }
      done < <(find "$platform_cgroup" -type d -name "$unit")
    fi
  done < "$STATE/units"
  # Preserve the shared budget tree, mounted work volumes and evidence for P and
  # the final owner cleanup. No tree-wide kill, delete, global prune or lazy unmount.
  return "$status"
}

case $OP in
  prepare) [[ $# == 0 ]] || fail 'unexpected arguments'; prepare ;;
  build) [[ $# == 0 ]] || fail 'unexpected arguments'; build ;;
  paths) [[ $# == 0 ]] || fail 'unexpected arguments'; check_all; paths ;;
  run) run "$@" ;;
  cleanup) [[ $# == 0 ]] || fail 'unexpected arguments'; cleanup ;;
  _build) [[ $# == 0 ]] || fail 'unexpected arguments'; build_inner ;;
  *) fail 'unknown operation' ;;
esac
