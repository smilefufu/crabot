"""Response-loss checks; these never contact Docker or the guest."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("osb_probe", Path(__file__).with_name("osb_probe.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CreateUncertaintyTests(unittest.TestCase):
    def make_probe(self):
        observer = module.Probe.__new__(module.Probe)
        observer.root = Path("/qualification-test")
        observer.state = {"instances": {"a": {"image": "sha256:" + "a" * 64}}}
        observer.ids, observer.data, observer.report, observer.canaries = {}, {}, {}, {}
        observer.create_attempted, observer.create_unknown = set(), set()
        observer.docker = Mock(side_effect=AssertionError("must not discover/delete unowned objects"))
        return observer

    def test_lost_create_response_stays_unknown_without_retry(self):
        observer = self.make_probe()
        observer.api = Mock(side_effect=TimeoutError("lost create response"))
        with self.assertRaises(TimeoutError):
            observer.create("a")
        observer.cleanup()
        self.assertEqual(observer.api.call_count, 1)
        self.assertEqual(observer.ids, {})
        self.assertEqual(observer.create_unknown, {"a"})
        self.assertEqual(observer.report["cleanup"], "unknown")
        self.assertEqual(observer.report["cleanup_unknown_instances"], ["a"])
        observer.docker.assert_not_called()

    def test_endpoint_loss_retains_the_returned_identity(self):
        observer = self.make_probe()
        observer.api = Mock(side_effect=[{"id": "fixture-a"}, TimeoutError("lost endpoint response")])
        with self.assertRaises(TimeoutError):
            observer.create("a")
        self.assertEqual(observer.ids, {"a": "fixture-a"})
        self.assertEqual(observer.create_unknown, set())
        self.assertEqual(observer.create_attempted, {"a"})

    def test_throttle_observer_rejects_an_unlimited_usage_layer(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "cpu.max").write_text("max 100000\n")
            (path / "cpu.stat").write_text("usage_usec 100\nnr_throttled 0\n")
            with self.assertRaisesRegex(RuntimeError, "actual quota"):
                module.quota_cpu_snapshot(path)
            (path / "cpu.max").write_text("175000 100000\n")
            observed = module.quota_cpu_snapshot(path)
            self.assertEqual(observed["cpu.max"], "175000 100000")
            self.assertEqual(observed["path"], str(path))

    def test_pid_observer_requires_a_finite_leaf_below_fixed_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            leaf = parent / "container.scope"
            leaf.mkdir()
            (leaf / "pids.max").write_text("384\n")
            (leaf / "pids.events").write_text("max 7\n")
            self.assertEqual(module.pids_leaf_snapshot(leaf, parent)["pids.events"], "max 7")
            with self.assertRaisesRegex(RuntimeError, "below the fixed"):
                module.pids_leaf_snapshot(parent, parent)
            (leaf / "pids.max").write_text("max\n")
            with self.assertRaisesRegex(RuntimeError, "finite"):
                module.pids_leaf_snapshot(leaf, parent)

    def test_management_token_requires_matching_sidecar_and_no_renamed_env_leak(self):
        observer = self.make_probe()
        observer.secrets = []
        token = "synthetic-management-token"
        label = "opensandbox.io/egress-auth-token"
        sidecar = {"Env": ["OPENSANDBOX_EGRESS_TOKEN=" + token]}
        valid = observer.management_token_checks({"Labels": {label: token}, "Env": ["HOME=/fixture"]}, sidecar)
        self.assertTrue(all(valid.values()))
        self.assertTrue(all(isinstance(value, bool) for value in valid.values()))
        self.assertIn(token, observer.secrets)
        for missing in ({}, {"Labels": {label: ""}}):
            with self.subTest(missing=missing):
                self.assertFalse(any(observer.management_token_checks(missing, sidecar).values()))
        leaked = observer.management_token_checks({"Labels": {label: token}, "Env": ["RENAMED_SECRET=" + token]}, sidecar)
        self.assertFalse(leaked["management_token_not_work_env"])
        mismatched = observer.management_token_checks({"Labels": {label: token}}, {"Env": ["OPENSANDBOX_EGRESS_TOKEN=different-token"]})
        self.assertFalse(mismatched["management_token_matches_sidecar"])
        self.assertIn("different-token", observer.secrets)


if __name__ == "__main__":
    unittest.main()
