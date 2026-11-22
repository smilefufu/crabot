#!/usr/bin/env python3
"""Stdlib checks; never imports OpenSandbox or connects to Docker."""
import ast
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("osb_patch", Path(__file__).with_name("osb_patch.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = types.ModuleType("qualification_policy")
        exec(module.POLICY, self.policy.__dict__)
        self.limits = {"parent": "qa-a-work.slice", "cgroup_path": "/qa.slice/qa-a.slice/qa-a-work.slice",
                       "memory_bytes": 1024 ** 3, "nano_cpus": 1750000000, "pids": 384}
        self.policy.manifest = lambda: {"roles": {role: self.limits for role in ("work", "auxiliary", "infrastructure")}}
        docker_types = types.ModuleType("docker.types")
        docker_types.LogConfig = lambda **kwargs: kwargs
        self.docker_modules = patch.dict(sys.modules, {"docker": types.ModuleType("docker"), "docker.types": docker_types})
        self.docker_modules.start()
        self.addCleanup(self.docker_modules.stop)

    def test_fixed_limits_override_request_values(self):
        given = {"mem_limit": 99, "nano_cpus": 99, "pids_limit": 99, "cgroup_parent": "evil.slice"}
        actual = self.policy.host_config("work", given)
        self.assertEqual(actual["cgroup_parent"], self.limits["parent"])
        self.assertEqual(actual["mem_limit"], 1024 ** 3)
        self.assertEqual(actual["memswap_limit"], 1024 ** 3)
        self.assertEqual(actual["pids_limit"], 384)
        self.assertEqual(given["cgroup_parent"], "evil.slice")

    def test_outer_security_cannot_be_relaxed(self):
        for value in ({"privileged": True}, {"cap_add": ["SYS_ADMIN"]},
                      {"security_opt": ["seccomp=unconfined"]}, {"devices": ["/dev/kvm"]}):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                self.policy.host_config("work", value)
        self.policy.host_config("auxiliary", {"cap_add": ["NET_ADMIN"]})

    def test_inspect_mismatch_fails_without_migration(self):
        container = types.SimpleNamespace(reload=lambda: None, attrs={"HostConfig": {"Memory": 1}})
        with self.assertRaisesRegex(RuntimeError, "no migration"):
            self.policy.verify(container, "work")

    def test_all_patch_fragments_parse(self):
        ast.parse(module.POLICY)
        self.assertEqual(module.replace_once("old", "old", "new", "test"), "new")
        with self.assertRaises(ValueError):
            module.replace_once("old old", "old", "new", "duplicate")

    def test_wrong_source_is_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "server/opensandbox_server/services/docker"
            target.mkdir(parents=True)
            for name in module.FILES:
                (target / name).write_text("unexpected = True\n")
            with self.assertRaisesRegex(ValueError, "pinned stable"):
                module.patched_files(root)
            self.assertEqual((target / "container_ops.py").read_text(), "unexpected = True\n")
            self.assertFalse((target / "prototype_policy.py").exists())

    def test_live_process_outside_parent_is_rejected(self):
        attrs = {"HostConfig": {"CgroupParent": self.limits["parent"], "Memory": 1024 ** 3,
                 "MemorySwap": 1024 ** 3, "NanoCpus": 1750000000, "PidsLimit": 384},
                 "State": {"Pid": 123}}
        container = types.SimpleNamespace(reload=lambda: None, attrs=attrs)
        with patch.object(Path, "read_text", return_value="0::/other.slice/docker-x.scope\n"):
            with self.assertRaisesRegex(RuntimeError, "escaped"):
                self.policy.verify(container, "work", running=True)

    def test_multiple_containers_share_one_aggregate_parent(self):
        first = self.policy.host_config("work", {})
        second = self.policy.host_config("work", {})
        self.assertEqual(first["cgroup_parent"], second["cgroup_parent"])
        self.assertIn("NET_ADMIN", first["cap_drop"])
        self.assertNotIn("NET_ADMIN", self.policy.host_config("auxiliary", {})["cap_drop"])


if __name__ == "__main__":
    unittest.main()
