#!/usr/bin/env python3
"""Apply the bounded resource-only patch to OpenSandbox release-1.2.1.

No Docker calls are made by this patcher. Runtime configuration comes only from
the root-owned CRABOT_OSB_MANIFEST file, never a sandbox request or metadata.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path


FILES = {
    "container_ops.py": "c0e742e9c27028eeedde648a86d1d237508648374a15772af8ad5c5283ff95f8",
    "networking.py": "27272548256ecebdeec4433be45b2067278c49b77bb83ce27559d1f2d882c672",
    "runtime.py": "c5fbdd541422159254dc4ca30f3911adc81327c211adea53fb5c3e016d7f7064",
    "docker_service.py": "f8bc3b32e634d27c578e2dac737a8068ea139d2ba0ad2b7cd6b4a425a37379ba",
}

POLICY = '''"""Qualification-only fixed resource policy; not a product API."""
import functools
import json
import os
from pathlib import Path
import re
import stat


@functools.lru_cache(maxsize=1)
def manifest():
    path = Path(os.environ["CRABOT_OSB_MANIFEST"])
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077:
        raise RuntimeError("qualification manifest must be a root-owned private regular file")
    parent = path.parent.stat()
    if parent.st_uid != 0 or parent.st_mode & 0o022:
        raise RuntimeError("qualification manifest directory is not protected")
    data = json.loads(path.read_text())
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}", data["instance_id"]):
        raise RuntimeError("invalid qualification instance")
    if data["docker_host"] != os.environ.get("DOCKER_HOST") or not data["docker_host"].startswith("unix://"):
        raise RuntimeError("qualification Docker socket mismatch")
    for role in ("work", "auxiliary", "infrastructure"):
        value = data["roles"][role]
        if not re.fullmatch(r"[a-zA-Z0-9_-]+\\.slice", value["parent"]):
            raise RuntimeError("qualification parent must be a fixed systemd slice")
        cg = Path(value["cgroup_path"])
        if not cg.is_absolute() or ".." in cg.parts or str(cg) == "/":
            raise RuntimeError("invalid qualification cgroup path")
        if not (Path("/sys/fs/cgroup") / str(cg).lstrip("/") / "cgroup.procs").is_file():
            raise RuntimeError("qualification parent cgroup is not prepared")
        for key in ("memory_bytes", "nano_cpus", "pids"):
            if type(value[key]) is not int or value[key] <= 0:
                raise RuntimeError("qualification resource limit must be a positive integer")
    return data


def host_config(role, original):
    from docker.types import LogConfig
    value = manifest()["roles"][role]
    result = dict(original)
    if result.get("privileged") or result.get("devices") or result.get("device_requests"):
        raise RuntimeError("qualification forbids privileged workloads and device access")
    if any("unconfined" in str(item) for item in result.get("security_opt", [])):
        raise RuntimeError("qualification forbids unconfined security profiles")
    allowed_caps = {"NET_ADMIN"} if role == "auxiliary" else set()
    if set(result.get("cap_add", [])) - allowed_caps:
        raise RuntimeError("qualification forbids added workload capabilities")
    drops = set(result.get("cap_drop", []))
    drops.update({"AUDIT_WRITE", "MKNOD", "NET_RAW", "SYS_ADMIN", "SYS_MODULE", "SYS_PTRACE", "SYS_TIME", "SYS_TTY_CONFIG"})
    if role != "auxiliary":
        drops.add("NET_ADMIN")
    opts = list(result.get("security_opt", []))
    if "no-new-privileges=true" not in opts:
        opts.append("no-new-privileges=true")
    result.update(cgroup_parent=value["parent"], mem_limit=value["memory_bytes"],
                  memswap_limit=value["memory_bytes"], nano_cpus=value["nano_cpus"],
                  pids_limit=value["pids"], security_opt=opts, cap_drop=sorted(drops),
                  log_config=LogConfig(type="local", config={"max-size": "1m", "max-file": "2"}))
    return result


def verify(container, role, running=False):
    container.reload()
    value = manifest()["roles"][role]
    actual = container.attrs.get("HostConfig", {})
    expected = {"CgroupParent": value["parent"], "Memory": value["memory_bytes"],
                "MemorySwap": value["memory_bytes"], "NanoCpus": value["nano_cpus"],
                "PidsLimit": value["pids"]}
    if any(actual.get(key) != wanted for key, wanted in expected.items()):
        raise RuntimeError("qualification resource inspection mismatch; no migration attempted")
    pid = container.attrs.get("State", {}).get("Pid", 0)
    if running and not pid:
        raise RuntimeError("qualification container exited before process verification")
    if pid:
        entries = Path(f"/proc/{pid}/cgroup").read_text().splitlines()
        actual_paths = [line[3:] for line in entries if line.startswith("0::")]
        parent = value["cgroup_path"].rstrip("/")
        if len(actual_paths) != 1 or not actual_paths[0].startswith(parent + "/"):
            raise RuntimeError("qualification process escaped its fixed resource parent")


def verify_restore(service):
    # Deliberately do not introduce owner/filter/recovery semantics. A second
    # instance's objects will fail this check on restart; record that limitation.
    manifest()
    for container in service.docker_client.containers.list(all=True, ignore_removed=True):
        attrs = container.attrs
        labels = attrs.get("Config", {}).get("Labels") or {}
        if labels.get("opensandbox.io/egress-sidecar-for"):
            verify(container, "auxiliary")
        elif labels.get("opensandbox.io/id"):
            verify(container, "work")
        elif container.name.startswith("sandbox-execd-"):
            verify(container, "infrastructure")
'''


def replace_once(text, old, new, label):
    if text.count(old) != 1:
        raise ValueError(f"stable patch anchor mismatch: {label}")
    return text.replace(old, new, 1)


def patched_files(source):
    directory = source / "server/opensandbox_server/services/docker"
    result = {}
    for name, expected in FILES.items():
        path = directory / name
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != expected:
            raise ValueError(f"not the pinned stable source: {name}")
        value = content.decode()
        value = replace_once(value, "logger = logging.getLogger(__name__)",
            "from .prototype_policy import host_config as prototype_host_config, verify as prototype_verify, verify_restore as prototype_verify_restore\n\nlogger = logging.getLogger(__name__)", name + " import")
        if name == "container_ops.py":
            value = replace_once(value, "        host_config = self.docker_client.api.create_host_config(**host_config_kwargs)",
                '        if unconfine_system_paths:\n            raise RuntimeError("qualification forbids unconfined system paths")\n        host_config_kwargs = prototype_host_config("work", host_config_kwargs)\n        host_config = self.docker_client.api.create_host_config(**host_config_kwargs)', "work create")
            value = replace_once(value, "            container = self.docker_client.containers.get(container_id)",
                '            container = self.docker_client.containers.get(container_id)\n            prototype_verify(container, "work")', "work inspect")
            value = replace_once(value, "                container.start()", '                container.start()\n                prototype_verify(container, "work", running=True)', "work start")
        elif name == "networking.py":
            value = replace_once(value, "            return self.docker_client.api.create_host_config(**sidecar_host_config_kwargs)",
                '            sidecar_host_config_kwargs = prototype_host_config("auxiliary", sidecar_host_config_kwargs)\n            return self.docker_client.api.create_host_config(**sidecar_host_config_kwargs)', "egress create including retry")
            value = replace_once(value, "            sidecar_container = self.docker_client.containers.get(sidecar_container_id)",
                '            sidecar_container = self.docker_client.containers.get(sidecar_container_id)\n            prototype_verify(sidecar_container, "auxiliary")', "egress inspect")
            value = replace_once(value, "                sidecar_container.start()", '                sidecar_container.start()\n                prototype_verify(sidecar_container, "auxiliary", running=True)', "egress start")
        elif name == "runtime.py":
            value = replace_once(value, "                    container = self.docker_client.containers.create(**create_kwargs)",
                '                    create_kwargs = prototype_host_config("infrastructure", create_kwargs)\n                    container = self.docker_client.containers.create(**create_kwargs)\n                    prototype_verify(container, "infrastructure")', "cache create")
            value = replace_once(value, "                    container.start()", '                    container.start()\n                    prototype_verify(container, "infrastructure", running=True)', "cache start")
        else:
            value = replace_once(value, "        self._restore_existing_sandboxes()", "        prototype_verify_restore(self)\n        self._restore_existing_sandboxes()", "restore verification")
        ast.parse(value, filename=name)
        result[path] = value
    ast.parse(POLICY)
    result[directory / "prototype_policy.py"] = POLICY
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--check", action="store_true", help="validate original source without writing")
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    marker = source / ".crabot-qualification-patch.json"
    if marker.exists():
        recorded = json.loads(marker.read_text())
        helper = "server/opensandbox_server/services/docker/prototype_policy.py"
        if recorded.get(helper) != hashlib.sha256(POLICY.encode()).hexdigest():
            raise SystemExit("existing patch uses a different policy; start from the pinned source")
        for relative, digest in recorded.items():
            if hashlib.sha256((source / relative).read_bytes()).hexdigest() != digest:
                raise SystemExit("previously patched source changed; refusing to reapply")
        print("qualification resource patch already matches")
        return
    changes = patched_files(source)
    if not args.check:
        for path, content in changes.items():
            path.write_text(content)
        marker.write_text(json.dumps({str(path.relative_to(source)): hashlib.sha256(content.encode()).hexdigest()
                                     for path, content in changes.items()}, indent=2) + "\n")
    print(f"qualification resource patch {'checked' if args.check else 'applied'}: {len(changes)} files")


if __name__ == "__main__":
    main()
