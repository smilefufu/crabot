#!/usr/bin/env python3
"""Bounded, guest-only route-P probes. No product execution bridge or Provider.

Run this trusted observer in the prepared infrastructure slice. Default probes
identity, real cgroups, private paths, deny-all policy, and persistent files.
--resources additionally runs the same finite fixture CPU/PID/disk/memory loads.
All fixtures use the existing execd API; no docker exec substitutes for it.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

MIB = 1024 * 1024
MAX_RESPONSE = 2 * MIB


def quota_cpu_snapshot(directory):
    quota = (directory / "cpu.max").read_text().strip()
    fields = quota.split()
    if len(fields) != 2 or fields[0] == "max" or not all(value.isdecimal() and int(value) > 0 for value in fields):
        raise RuntimeError("CPU throttle observation requires a cgroup with an actual quota")
    return {"path":str(directory), "cpu.max":quota,
            "cpu.stat":(directory / "cpu.stat").read_text().strip()}


def pids_leaf_snapshot(directory, parent):
    if directory == parent or not directory.is_relative_to(parent):
        raise RuntimeError("PID observation must be below the fixed work parent")
    limit = (directory / "pids.max").read_text().strip()
    if not limit.isdecimal() or int(limit) <= 0:
        raise RuntimeError("PID observation requires an actual finite limit")
    return {"path":str(directory), "pids.max":limit,
            "pids.events":(directory / "pids.events").read_text().strip()}


def protected_json(path, private=True):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & (0o077 if private else 0o022):
        raise RuntimeError("observer metadata must be a root-owned private regular file")
    return json.loads(path.read_text())


def guest_guard(root):
    if sys.platform != "linux" or os.geteuid() != 0:
        raise RuntimeError("requires the authorized Linux guest and root")
    if os.uname().release != "6.8.0-147-generic":
        raise RuntimeError("qualification kernel changed from the frozen baseline")
    if not root.is_absolute() or root == Path("/") or root.resolve() != root:
        raise RuntimeError("task root must be a canonical real directory")
    info = root.stat()
    if info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("task root is not protected")
    marker = root / ".guest-authorization"
    info = marker.lstat()
    expected = "crabot-sandbox-qualification-phase1\n" + Path("/etc/machine-id").read_text().strip()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or marker.read_text().strip() != expected:
        raise RuntimeError("guest authorization mismatch")
    budgets = protected_json(root / "native/budgets.json", private=False)["budgets"]
    membership = Path("/proc/self/cgroup").read_text().strip()
    infrastructure = budgets["infrastructure"]["ControlGroup"]
    if not membership.startswith("0::" + infrastructure + "/"):
        raise RuntimeError("observer must enter infrastructure before execution")
    return budgets


def decode_sse(raw):
    """Keep stdout/stderr separately bounded; absence of exit is not success."""
    output = {"stdout": "", "stderr": "", "exit_code": None, "error": None, "events": []}
    for block in raw.decode("utf-8", errors="replace").replace("\r\n", "\n").split("\n\n"):
        event_name, data = "", []
        for line in block.splitlines():
            if line.startswith("event:"):
                event_name = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())
        if not data:
            continue
        event = json.loads("\n".join(data))
        kind = event.get("type", event_name)
        output["events"].append(kind)
        if kind in ("stdout", "stderr"):
            output[kind] += event.get("text", "")
            if len(output[kind].encode()) > MIB:
                raise RuntimeError("command output exceeded its bound")
        if kind == "execution_complete":
            output["exit_code"] = event.get("exit_code")
        if kind == "error":
            output["error"] = event.get("error") or {"type": "unclassified"}
            output["exit_code"] = (event.get("error") or {}).get("exit_code")
    return output


class Probe:
    def __init__(self, root, budgets):
        self.root, self.budgets = root, budgets
        self.state = protected_json(root / "p/bootstrap.json")
        if self.state["docker_host"] != "unix://" + str(root / "docker.sock"):
            raise RuntimeError("private engine socket mismatch")
        self.env = {"PATH": str(root / "p/bin") + ":/usr/sbin:/usr/bin:/sbin:/bin",
                    "DOCKER_HOST": self.state["docker_host"], "LANG": "C.UTF-8"}
        self.keys = {name: (root / "osb" / name / "api-key").read_text().strip() for name in ("a", "b")}
        self.ids, self.data, self.failures = {}, {}, []
        self.create_attempted, self.create_unknown = set(), set()
        self.report = {"route": "P", "started": time.time(), "checks": [], "cleanup": "not_started",
                       "not_tested": ["cross-server restore: stock shared-daemon ownership limitation",
                                      "DNS rebinding/redirect/IPv6 and saturated CPU fair-share scenarios",
                                      "transient execd-cache not independently sampled; patched helper verifies its actual create/start limits",
                                      "VNC/browser/full CLI and real Crabot integration"]}
        self.secrets = list(self.keys.values())
        nonce = os.urandom(8).hex()
        self.canaries = {name:root / "native/control" / name / ("p-canary-" + nonce) for name in ("a", "b")}
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def record(self, name, passed, detail):
        self.report["checks"].append({"name": name, "status": "passed" if passed else "failed", "detail": detail})
        if not passed:
            self.failures.append(name)

    def docker(self, *args):
        result = subprocess.run([str(self.root / "p/bin/docker"), *args], env=self.env,
                                capture_output=True, timeout=15)
        if result.returncode or len(result.stdout) > 4 * MIB or len(result.stderr) > MIB:
            raise RuntimeError("bounded Docker inspection failed")
        return result.stdout.decode()

    def request(self, url, method="GET", body=None, headers=None, timeout=15):
        encoded = None if body is None else json.dumps(body).encode()
        all_headers = {"Content-Type": "application/json", **(headers or {})}
        request = urllib.request.Request(url, data=encoded, headers=all_headers, method=method)
        try:
            with self.http.open(request, timeout=timeout) as response:
                raw = response.read(MAX_RESPONSE + 1)
                code = response.status
        except urllib.error.HTTPError as error:
            code, raw = error.code, error.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise RuntimeError("HTTP response exceeded its bound")
        return code, raw

    def api(self, name, path, method="GET", body=None, timeout=15):
        port = self.state["instances"][name]["port"]
        code, raw = self.request(f"http://127.0.0.1:{port}" + path, method, body,
                                 {"OPEN-SANDBOX-API-KEY": self.keys[name]}, timeout)
        if not 200 <= code < 300:
            # Keep error diagnostics bounded; report writing redacts known keys.
            raise RuntimeError(f"OSB HTTP {code}: {raw[:512].decode(errors='replace')}")
        return json.loads(raw) if raw else None

    def create(self, name):
        info = self.state["instances"][name]
        volumes = [{"name": "fixtures", "host": {"path": str(self.root / "fixtures")},
                    "mountPath": "/fixtures", "readOnly": True},
                   {"name": "machine-id", "host": {"path": str(self.root / "fixtures/machine-id")},
                    "mountPath": "/etc/machine-id", "readOnly": True},
                   {"name": "workspace", "host": {"path": str(self.root / "native/workspaces" / name)},
                    "mountPath": "/workspace", "readOnly": False}]
        body = {"image": {"uri": info["image"]}, "entrypoint": ["/bin/sh", "-c", "sleep 2400"],
                "timeout": None, "resourceLimits": {"cpu": "1.75", "memory": "1Gi", "disk": "1Gi"},
                "networkPolicy": {"defaultAction": "deny", "egress": []}, "volumes": volumes,
                "platform": {"os": "linux", "arch": "arm64"}}
        self.create_attempted.add(name)
        self.create_unknown.add(name)
        result = self.api(name, "/sandboxes", "POST", body, timeout=180)
        identifier = result["id"]
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", identifier):
            raise RuntimeError("invalid returned sandbox identity")
        self.ids[name] = identifier
        self.create_unknown.discard(name)
        endpoint = self.api(name, f"/sandboxes/{identifier}/endpoints/44772")
        self.data[name] = endpoint
        address = endpoint["endpoint"]
        if not address.startswith(("127.0.0.1:", "http://127.0.0.1:")):
            raise RuntimeError("data endpoint is not task-private loopback")
        self.record(name + ":create_with_disk", True, {"id": identifier, "disk_requested_bytes": 1024 * MIB})

    def inspect(self, name):
        return json.loads(self.docker("inspect", "sandbox-" + self.ids[name]))[0]

    def command(self, name, argv, timeout_ms=35000, uid=None):
        data = self.data[name]
        address = data["endpoint"]
        if not address.startswith("http://"):
            address = "http://" + address
        body = {"argv": argv, "cwd": "/workspace", "background": False, "timeout": timeout_ms}
        if uid is not None:
            body.update(uid=uid, gid=uid)
        code, raw = self.request(address.rstrip("/") + "/command", "POST", body,
                                 data.get("headers") or {}, timeout=timeout_ms / 1000 + 5)
        if code != 200:
            return {"http_status": code, "exit_code": None, "error": {"type": "HTTPError"}, "stdout": "", "stderr": ""}
        result = decode_sse(raw)
        result["http_status"] = code
        return result

    def fixture(self, name, *args, root="/workspace"):
        return self.command(name, ["/usr/local/bin/python3", "/fixtures/fixture.py", "--root", root,
                                  "--authorization-file", "/fixtures/.guest-authorization", *args])

    def management_token_checks(self, work, auxiliary):
        token = (work.get("Labels") or {}).get("opensandbox.io/egress-auth-token")
        present = isinstance(token, str) and bool(token.strip())
        sidecar_tokens = [entry.partition("=")[2] for entry in auxiliary.get("Env", [])
                          if entry.startswith("OPENSANDBOX_EGRESS_TOKEN=")]
        self.secrets.extend(value for value in sidecar_tokens if value)
        if present:
            self.secrets.append(token)
        return {"management_token_present": present,
                "management_token_not_work_env": present and not any(
                    token in entry or entry.startswith(("OPENSANDBOX_EGRESS_TOKEN=", "OPENSANDBOX_SERVER_API_KEY="))
                    for entry in work.get("Env", [])),
                "management_token_matches_sidecar": present and sidecar_tokens == [token]}

    def inspect_boundaries(self, name):
        actual = self.inspect(name)
        info = self.state["instances"][name]
        host, config = actual["HostConfig"], actual["Config"]
        manifest = protected_json(Path(info["manifest"]))
        policy = manifest["roles"]["work"]
        expected = {"CgroupParent": policy["parent"], "Memory": 1024 * MIB,
                    "MemorySwap": 1024 * MIB, "NanoCpus": 1750000000, "PidsLimit": 384}
        checks = {key: host.get(key) == value for key, value in expected.items()}
        pid = actual["State"]["Pid"]
        membership = Path(f"/proc/{pid}/cgroup").read_text().strip()
        checks["actual_cgroup"] = membership.startswith("0::" + policy["cgroup_path"] + "/")
        checks["image_user"] = config.get("User") == f'{info["uid"]}:{info["uid"]}'
        checks["non_privileged"] = not host.get("Privileged") and "SYS_ADMIN" not in (host.get("CapAdd") or [])
        checks["profiles"] = not any("unconfined" in x for x in host.get("SecurityOpt", []))
        mounts = {item["Destination"]: item for item in actual["Mounts"]}
        checks["fixtures_readonly"] = mounts.get("/fixtures", {}).get("RW") is False
        checks["machineid_readonly"] = mounts.get("/etc/machine-id", {}).get("RW") is False
        checks["workspace_only"] = mounts.get("/workspace", {}).get("Source") == str(self.root / "native/workspaces" / name)
        size = (host.get("StorageOpt") or {}).get("size")
        checks["disk_storage_option"] = str(size) in ("1073741824", "1G", "1GiB")
        main_uid = next(line for line in Path(f"/proc/{pid}/status").read_text().splitlines() if line.startswith("Uid:"))
        checks["bootstrap_uid"] = all(int(value) == info["uid"] for value in main_uid.split()[1:])
        checks["private_namespaces"] = all(os.readlink(f"/proc/{pid}/ns/{kind}") != os.readlink(f"/proc/self/ns/{kind}")
                                            for kind in ("mnt", "pid", "ipc", "net"))
        # Docker inspect includes management token labels; retain only booleans.
        auxiliary = json.loads(self.docker("inspect", "sandbox-egress-" + self.ids[name]))[0]
        checks.update(self.management_token_checks(config, auxiliary["Config"]))
        self.record(name + ":actual_boundaries", all(checks.values()), {"checks": checks, "pid": pid,
                    "actual_cgroup": membership, "storage_size": size, "uid": info["uid"]})
        aux_host, aux_policy = auxiliary["HostConfig"], manifest["roles"]["auxiliary"]
        aux_checks = {"parent":aux_host.get("CgroupParent") == aux_policy["parent"],
                      "memory":aux_host.get("Memory") == aux_policy["memory_bytes"],
                      "swap":aux_host.get("MemorySwap") == aux_policy["memory_bytes"],
                      "cpu":aux_host.get("NanoCpus") == aux_policy["nano_cpus"],
                      "pids":aux_host.get("PidsLimit") == aux_policy["pids"],
                      "non_privileged":not aux_host.get("Privileged") and "SYS_ADMIN" not in (aux_host.get("CapAdd") or [])}
        aux_pid = auxiliary["State"]["Pid"]
        aux_group = Path(f"/proc/{aux_pid}/cgroup").read_text().strip()
        aux_checks["actual_cgroup"] = aux_group.startswith("0::" + aux_policy["cgroup_path"] + "/")
        self.record(name + ":auxiliary_actual_limits", all(aux_checks.values()), {"checks":aux_checks,"pid":aux_pid,"actual_cgroup":aux_group})
        command = self.fixture(name, "inspect")
        observed = json.loads(command["stdout"])
        status = observed.get("process_status", {})
        identity_ok = (command["exit_code"] == 0 and observed.get("uid") == info["uid"] and observed.get("gid") == info["uid"]
                       and status.get("NoNewPrivs") == "1" and status.get("Seccomp") == "2"
                       and int(status.get("CapEff", "1"), 16) == 0)
        self.record(name + ":execd_identity", identity_ok, observed)
        escalation = self.command(name, ["/usr/local/bin/python3", "-c", "import os; print(os.getuid())"], uid=0)
        self.record(name + ":uid0_rejected", bool(escalation.get("error")) and escalation["stdout"].strip() != "0", {"http_status": escalation["http_status"], "error": escalation.get("error")})
        paths = self.fixture(name, "probe-paths", "--path", str(self.canaries[name]),
                             "--path", str(self.root / "osb" / name / "api-key"), "--path", str(self.root / "docker.sock"))
        path_result = json.loads(paths["stdout"])
        self.record(name + ":private_paths", paths["exit_code"] == 0 and all(not x["readable"] for x in path_result["results"]), path_result)

    def policy_negative(self, name):
        code = '''import json, urllib.request, urllib.error
r=[]
for path in ("/policy","/credential-vault"):
 for supplied in (False,True):
  headers={"Content-Type":"application/json"}
  if supplied: headers["OPENSANDBOX-EGRESS-AUTH"]="deliberately-wrong"
  q=urllib.request.Request("http://127.0.0.1:18080"+path,data=b'{"defaultAction":"allow","egress":[]}',headers=headers,method="POST")
  try:
   with urllib.request.urlopen(q,timeout=2) as response: status=response.status
  except urllib.error.HTTPError as error: status=error.code
  r.append({"path":path,"fake_token":supplied,"status":status})
print(json.dumps(r))'''
        result = self.command(name, ["/usr/local/bin/python3", "-c", code])
        observations = json.loads(result["stdout"])
        self.record(name + ":policy_cannot_self_authorize", result["exit_code"] == 0 and all(x["status"] == 401 for x in observations), observations)

    def deny_synthetic_host(self, name):
        network = json.loads(self.docker("network", "inspect", "bridge"))[0]
        gateway = network["IPAM"]["Config"][0]["Gateway"]
        # This is a newly registered TCP-only synthetic endpoint inside the
        # disposable guest. Nothing listens on LAN/Mac; no real service scan.
        with socket.socket() as listener:
            listener.bind((gateway, 0)); listener.listen(4)
            port = listener.getsockname()[1]
            with socket.create_connection((gateway, port), timeout=1):
                pass
            result = self.fixture(name, "probe-network", "--endpoint", f"tcp://{gateway}:{port}")
        observed = json.loads(result["stdout"])
        attempts = observed["results"][0]["attempts"]
        self.record(name + ":synthetic_host_denied", result["exit_code"] == 0 and bool(attempts)
                    and all(not item["connected"] for item in attempts), observed)

    def persist(self, name):
        path, value = "p-qualified-file.txt", "agent-side-content"
        result = self.fixture(name, "file-persist", "write", "--path", path, "--value", value)
        host = self.root / "native/workspaces" / name / path
        uid = self.state["instances"][name]["uid"]
        passed = result["exit_code"] == 0 and host.stat().st_uid == uid
        human = subprocess.run(["/usr/bin/setpriv", "--reuid", str(uid), "--regid", str(uid), "--clear-groups",
                                "/usr/bin/python3", "-c", "from pathlib import Path; import sys; p=Path(sys.argv[1]); assert p.read_text()==sys.argv[2]; p.write_text('human-side-content')", str(host), value],
                               capture_output=True, timeout=5)
        reread = self.fixture(name, "file-persist", "read", "--path", path)
        expected = hashlib.sha256(b"human-side-content").hexdigest()
        passed = passed and human.returncode == 0 and reread["exit_code"] == 0 and json.loads(reread["stdout"])["sha256"] == expected
        self.record(name + ":human_file_handoff", passed, {"host_owner_uid": host.stat().st_uid,
                    "human_simulation_returncode": human.returncode, "agent_read_latest": passed})

    def positive_network(self, name):
        gateway = json.loads(self.docker("network", "inspect", "bridge"))[0]["IPAM"]["Config"][0]["Gateway"]
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.send_header("Content-Length", "20")
                self.send_header("Connection", "close"); self.end_headers()
                self.wfile.write(b"qualification-canary")
            def log_message(self, *_args):
                pass
        server = http.server.HTTPServer((gateway, 0), Handler)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval":0.1}, daemon=True)
        thread.start(); port = server.server_address[1]
        code = '''import json,urllib.request,urllib.error
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
 with opener.open(URL,timeout=2) as response: result={"status":response.status,"body":response.read(64).decode()}
except (OSError,urllib.error.URLError): result={"blocked":True}
print(json.dumps(result))'''.replace("URL", repr(f"http://{gateway}:{port}/"))
        def fetch():
            result = self.command(name, ["/usr/local/bin/python3", "-c", code], timeout_ms=5000)
            if result["exit_code"] != 0:
                raise RuntimeError("synthetic egress probe did not finish")
            return json.loads(result["stdout"])
        path = f"/sandboxes/{self.ids[name]}/networkpolicy"
        reset = {"defaultAction":"deny","egress":[]}
        changed = False
        try:
            before = fetch()
            self.api(name, path, "PUT", {"defaultAction":"deny","egress":[{"action":"allow","target":gateway,"ports":[port]}]})
            changed = True
            allowed = fetch()
            self.policy_negative(name)
            self.api(name, path, "PUT", reset); changed = False
            after = fetch()
            passed = before.get("blocked") is True and allowed == {"status":200,"body":"qualification-canary"} and after.get("blocked") is True
            self.record(name + ":exact_synthetic_egress", passed,
                        {"gateway":gateway,"port":port,"default_deny":before,"exact_allow":allowed,"revoked":after})
        finally:
            try:
                if changed:
                    self.api(name, path, "PUT", reset)
            finally:
                server.shutdown(); server.server_close(); thread.join(2)

    def cgroup_events(self, name):
        group = Path(self.budgets[name + "/work"]["cgroup"])
        result = {}
        for file in ("memory.events", "memory.oom.group", "pids.events", "cpu.stat", "memory.current", "pids.current"):
            result[file] = (group / file).read_text().strip()
        # work is an aggregate usage layer without cpu.max quota. Throttling
        # counters must be read at the actual A/B instance quota boundary.
        result["quota_cpu"] = quota_cpu_snapshot(Path(self.budgets[name]["cgroup"]))
        pid = self.inspect(name)["State"]["Pid"]
        result["leaf_pids"] = None
        if pid > 0 and Path(f"/proc/{pid}/cgroup").exists():
            membership = Path(f"/proc/{pid}/cgroup").read_text().strip()
            if not membership.startswith("0::/") or "\n" in membership:
                raise RuntimeError("unexpected container cgroup membership")
            leaf = Path("/sys/fs/cgroup") / membership[4:]
            result["leaf_pids"] = pids_leaf_snapshot(leaf, group)
        return result

    def load(self, label, *args, root="/workspace"):
        before = self.cgroup_events("a")
        stop, fired = threading.Event(), threading.Event()
        health, control_health = [], []
        seconds = int(args[args.index("--seconds") + 1]) if "--seconds" in args else 10
        controls = []
        for name in ("a", "b"):
            command = ["/bin/bash", str(self.root / "scripts/native_route.sh"), str(self.root),
                       "run", name, "control", "--", "/usr/bin/python3", str(self.root / "fixtures/fixture.py"),
                       "--root", str(self.root / "native/control" / name), "health", "--seconds", str(seconds)]
            controls.append(subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE))
        started = time.monotonic_ns()
        ready_until = time.monotonic() + 5
        while time.monotonic() < ready_until:
            try:
                if all(json.loads((self.root / "native/control" / name / "control-health.json").read_text())["monotonic_ns"] >= started for name in ("a", "b")):
                    break
            except (OSError, ValueError, KeyError):
                pass
            time.sleep(0.1)
        def monitor():
            while not stop.is_set():
                try:
                    result = self.command("b", ["/usr/local/bin/python3", "-c", "print('healthy')"], timeout_ms=2000)
                    health.append(result["exit_code"] == 0 and result["stdout"].strip() == "healthy")
                except Exception:
                    health.append(False)
                try:
                    stamps = [json.loads((self.root / "native/control" / name / "control-health.json").read_text())["monotonic_ns"] for name in ("a", "b")]
                    control_health.append(all(time.monotonic_ns() - stamp < 3_000_000_000 for stamp in stamps))
                except (OSError, ValueError, KeyError):
                    control_health.append(False)
                stop.wait(2)
        def watchdog():
            fired.set()
            # Fixed root-protected manifest target, never a workload-supplied PID.
            (Path(self.budgets["a/work"]["cgroup"]) / "cgroup.kill").write_text("1")
        thread = threading.Thread(target=monitor, daemon=True); thread.start()
        timer = threading.Timer(45, watchdog); timer.daemon = True; timer.start()
        try:
            result = self.fixture("a", *args, root=root)
        except Exception as error:
            result = {"transport_error": type(error).__name__}
        finally:
            timer.cancel(); stop.set(); thread.join(5)
        control_results = []
        for control in controls:
            try:
                out, err = control.communicate(timeout=40)
                control_results.append(control.returncode == 0 and len(out) <= MIB and len(err) <= MIB)
            except subprocess.TimeoutExpired:
                # Native runner owns the recorded units and its independent
                # watchdog. Do not select an unverified PID/group to kill.
                control_results.append(False)
        after = self.cgroup_events("a")
        # Pressure outcome is evidence, not unconditional success. The caller
        # separately checks the relevant kernel event or fixture limit result.
        detail = {"command": result, "before": before, "after": after,
                  "b_health": health, "control_health":control_health, "control_results":control_results,
                  "watchdog_fired": fired.is_set()}
        self.record(label + ":other_instance_available", bool(health) and all(health) and bool(control_health)
                    and all(control_health) and all(control_results) and not fired.is_set(), detail)
        return result, before, after

    def resources(self):
        _, before, after = self.load("cpu", "cpu", "--threads", "2", "--seconds", "30")
        def counter(text, key):
            return int(dict(line.split() for line in text.splitlines()).get(key, 0))
        self.record("cpu:kernel_throttled", counter(after["quota_cpu"]["cpu.stat"],"nr_throttled") > counter(before["quota_cpu"]["cpu.stat"],"nr_throttled"),
                    {"quota_before":before["quota_cpu"],"quota_after":after["quota_cpu"],
                     "work_aggregate_before":before["cpu.stat"],"work_aggregate_after":after["cpu.stat"]})
        if self.failures:
            raise RuntimeError("CPU/availability qualification failed; no further pressure")
        tasks, before, after = self.load("pids", "tasks", "--count", "512", "--seconds", "5")
        leaf_before, leaf_after = before["leaf_pids"], after["leaf_pids"]
        leaf_hit = (leaf_before is not None and leaf_after is not None and leaf_before["path"] == leaf_after["path"]
                    and counter(leaf_after["pids.events"], "max") > counter(leaf_before["pids.events"], "max"))
        self.record("pids:kernel_limit", counter(after["pids.events"], "max") > counter(before["pids.events"], "max") or leaf_hit,
                    {"parent_before":before["pids.events"], "parent_after":after["pids.events"],
                     "leaf_before":leaf_before, "leaf_after":leaf_after})
        if self.failures:
            raise RuntimeError("PID/availability qualification failed; no further pressure")
        for location, volume in (("/workspace", "disk"), ("/tmp", "qualification")):
            created = self.command("a", ["/usr/local/bin/python3", "-c", "import os; os.makedirs('/workspace/disk',exist_ok=True)"])
            if created["exit_code"] != 0:
                raise RuntimeError("disk fixture directory preparation failed")
            result, _, _ = self.load("disk:" + location, "disk", "--volume", volume, "--bytes", str(1280 * MIB), root=location)
            observed = json.loads(result.get("stdout", "{}"))
            self.record("disk:" + location + ":hard_limit", observed.get("write_errno") in (28,122) or observed.get("errno") in (28,122), observed)
            if self.failures:
                raise RuntimeError("disk/availability qualification failed; no further pressure")
        # OOM is last: it may terminate the entire A work container/execd.
        _, before, after = self.load("memory", "mem", "--bytes", str(1536 * MIB), "--seconds", "2")
        self.record("memory:kernel_oom", counter(after["memory.events"], "oom_kill") > counter(before["memory.events"], "oom_kill"), {"before":before["memory.events"], "after":after["memory.events"]})

    def cleanup(self):
        # A lost create response is not proof that no resource was created.
        # Do not retry or discover/delete by broad name or label selectors.
        unknown = sorted(self.create_unknown)
        for name, identifier in self.ids.items():
            try:
                self.api(name, f"/sandboxes/{identifier}", "DELETE", timeout=30)
                remaining = self.docker("ps", "-aq", "--filter", "name=^/sandbox-" + identifier + "$", "--filter", "name=^/sandbox-egress-" + identifier + "$").strip()
                if remaining:
                    unknown.append(name)
            except Exception:
                unknown.append(name)
        self.report["cleanup"] = "unknown" if unknown else "containers_stopped"
        self.report["cleanup_unknown_instances"] = unknown
        for name in self.ids:
            host = self.root / "native/workspaces" / name / "p-qualified-file.txt"
            self.record(name + ":file_survives_stop", host.is_file() and host.read_text() == "human-side-content", {"persistent":host.is_file()})
        for path in self.canaries.values():
            if path.exists():
                path.unlink()

    def save(self):
        self.report.update(finished=time.time(), failures=self.failures,
                           create_attempted=sorted(self.create_attempted),
                           create_unknown=sorted(self.create_unknown))
        raw = json.dumps(self.report, indent=2)
        for secret in self.secrets:
            if secret:
                raw = raw.replace(secret, "[REDACTED]")
        if len(raw.encode()) > 16 * MIB:
            raise RuntimeError("report exceeded its bounded output")
        output = self.root / "p/probe-report.json"
        output.write_text(raw + "\n"); output.chmod(0o600)
        print(json.dumps({"report":str(output), "failed_checks":self.failures, "cleanup":self.report["cleanup"]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--resources", action="store_true")
    parser.add_argument("--positive-network", action="store_true", help="root authorizes one new guest-only HTTP canary endpoint")
    args = parser.parse_args()
    budgets = guest_guard(args.root)
    observer = Probe(args.root, budgets)
    try:
        for name in ("a", "b"):
            canary = observer.canaries[name]
            with canary.open("x") as stream:
                stream.write(os.urandom(32).hex())
            uid = observer.state["instances"][name]["uid"]
            canary.chmod(0o600); os.chown(canary, uid, uid)
            observer.create(name)
            observer.inspect_boundaries(name)
            if observer.failures:
                raise RuntimeError("a hard identity/resource boundary failed; stopping route")
            observer.policy_negative(name)
            observer.deny_synthetic_host(name)
            if observer.failures:
                raise RuntimeError("a hard network boundary failed; stopping route")
            observer.persist(name)
        if observer.failures:
            raise RuntimeError("a hard boundary failed; no pressure tests")
        if args.resources:
            observer.resources()
        else:
            observer.report["not_tested"].append("resource pressure: --resources not selected")
        if args.positive_network and not observer.failures:
            observer.positive_network("b")
        else:
            observer.report["not_tested"].append("exact synthetic positive egress not run")
    except Exception as error:
        observer.record("route_completed", False, {"type":type(error).__name__, "message":str(error)[:1024]})
    finally:
        observer.cleanup()
        observer.save()
    return 1 if observer.failures or observer.report["cleanup"] == "unknown" else 0


if __name__ == "__main__":
    raise SystemExit(main())
