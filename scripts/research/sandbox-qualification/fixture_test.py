"""Low-impact tests; load guards, threads, clocks and hashing are mocked."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

MODULE_PATH = Path(__file__).with_name("fixture.py")
SPEC = importlib.util.spec_from_file_location("qualification_fixture", MODULE_PATH)
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)


class ParsingTests(unittest.TestCase):
    def parse(self, *arguments):
        return fixture.parser().parse_args(["--root", "/not-used", *arguments])

    def reject(self, *arguments):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as caught:
            self.parse(*arguments)
        self.assertEqual(caught.exception.code, 2)
        self.assertEqual(json.loads(output.getvalue())["status"], "argument_error")

    def test_load_upper_bounds_are_accepted_without_running(self):
        cases = [
            ("cpu", "--threads", "2", "--seconds", "30"),
            ("mem", "--bytes", str(fixture.MAX_MEMORY)),
            ("tasks", "--count", "512"),
            ("disk", "--volume", "volume", "--bytes", str(fixture.MAX_DISK)),
        ]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                self.assertIsNotNone(self.parse(*arguments).run)

    def test_load_upper_and_lower_bounds_are_rejected(self):
        cases = [
            ("cpu", "--threads", "3"), ("cpu", "--threads", "0"),
            ("cpu", "--seconds", "31"),
            ("mem", "--bytes", str(fixture.MAX_MEMORY + 1)),
            ("mem", "--bytes", "0"),
            ("tasks", "--count", "513"), ("tasks", "--count", "-1"),
            ("disk", "--volume", "volume", "--bytes", str(fixture.MAX_DISK + 1)),
            ("disk", "--volume", "volume", "--bytes", "-1"),
        ]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                self.reject(*arguments)

    def test_deadline_cap(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit):
            fixture.parser().parse_args(["--deadline-seconds", "61", "inspect"])
        self.assertEqual(json.loads(output.getvalue())["status"], "argument_error")

    def test_network_accepts_only_explicit_tcp_endpoint(self):
        self.assertEqual(self.parse("probe-network", "--endpoint", "tcp://[::1]:1234")
                         .endpoint, ["tcp://[::1]:1234"])
        for value in ("http://localhost:80", "tcp://localhost", "tcp://host:0",
                      "tcp://host:65536", "tcp://u:p@host:80", "tcp://host:80/path",
                      "tcp://host:80?secret=1"):
            with self.subTest(value=value):
                self.reject("probe-network", "--endpoint", value)


class AuthorizationTests(unittest.TestCase):
    def marker_info(self, owner=65534, mode=0o444):
        return SimpleNamespace(st_mode=stat.S_IFREG | mode, st_uid=owner, st_size=90)

    def test_unmapped_marker_accepted_only_for_fixed_readonly_single_uid_maps(self):
        for host_uid in (62001, 62002):
            fixture.validate_marker_info(self.marker_info(), allow_unmapped=True,
                                         read_only=True, uid_map=f"  1000 {host_uid} 1\n")

    def test_unmapped_marker_opt_in_defaults_off(self):
        args = fixture.parser().parse_args(["--root", "/not-used", "inspect"])
        self.assertFalse(args.allow_unmapped_root_marker)
        with self.assertRaises(ValueError):
            fixture.validate_marker_info(self.marker_info(), read_only=True,
                                         uid_map="1000 62001 1\n")

    def test_unmapped_marker_rejects_writable_mount_mode_and_other_owners(self):
        for owner, mode, read_only in ((65534, 0o444, False), (65534, 0o664, True),
                                       (1000, 0o444, True), (62001, 0o444, True)):
            with self.subTest(owner=owner, mode=mode, read_only=read_only):
                with self.assertRaises(ValueError):
                    fixture.validate_marker_info(self.marker_info(owner, mode),
                                                 allow_unmapped=True, read_only=read_only,
                                                 uid_map="1000 62001 1\n")

    def test_unmapped_marker_rejects_host_or_widened_or_root_uid_maps(self):
        for mapping in ("0 0 4294967295\n", "1000 62001 2\n", "1000 62003 1\n",
                        "1000 62001 1\n0 0 1\n", "1000 0 1\n", "0 62001 1\n", ""):
            with self.subTest(mapping=mapping), self.assertRaises(ValueError):
                fixture.validate_marker_info(self.marker_info(), allow_unmapped=True,
                                             read_only=True, uid_map=mapping)

    def test_default_root_marker_stays_supported(self):
        fixture.validate_marker_info(self.marker_info(owner=0, mode=0o600))

    def test_cpu_workers_hash_bounded_gil_releasing_input_without_load(self):
        class ImmediateWorker:
            def __init__(self, target, args, daemon):
                self.target, self.args, self.ident = target, args, None

            def start(self):
                self.ident = 1
                self.target(*self.args)

            def is_alive(self):
                return False

            def join(self, _timeout):
                pass

        args = mock.Mock(threads=2, seconds=1)
        with mock.patch.object(fixture, "require_guest"):
            with mock.patch.object(fixture.threading, "Thread", ImmediateWorker):
                with mock.patch.object(fixture.time, "monotonic", side_effect=[0, 0, 2, 0, 2]):
                    with mock.patch.object(fixture.hashlib, "sha256") as hasher:
                        result = fixture.cpu(args)
        self.assertEqual(hasher.call_count, 2)
        first_block = hasher.call_args_list[0].args[0]
        self.assertGreater(len(first_block), 2047)
        self.assertLessEqual(len(first_block), fixture.MIB)
        self.assertIs(hasher.call_args_list[1].args[0], first_block)
        self.assertEqual(result["iterations"], 2)
        self.assertEqual(result["hashed_bytes"], 2 * len(first_block))

    def test_deadline_arms_restores_and_raises_without_waiting(self):
        previous = signal.getsignal(signal.SIGALRM)
        with mock.patch.object(fixture.signal, "setitimer") as timer:
            with self.assertRaises(fixture.DeadlineExceeded):
                with fixture.deadline(1):
                    signal.getsignal(signal.SIGALRM)(signal.SIGALRM, None)
            self.assertEqual(timer.call_args_list, [mock.call(signal.ITIMER_REAL, 1),
                                                    mock.call(signal.ITIMER_REAL, 0)])
        self.assertEqual(signal.getsignal(signal.SIGALRM), previous)

    def test_marker_is_bound_to_guest_machine_id(self):
        machine_id = "a" * 32
        fixture.validate_authorization(fixture.MARKER_KIND + "\n" + machine_id + "\n",
                                       machine_id + "\n")
        for value in (fixture.MARKER_KIND + "\n" + "b" * 32,
                      "other\n" + machine_id,
                      fixture.MARKER_KIND + "\n" + machine_id + "\nextra"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                fixture.validate_authorization(value, machine_id)

    def test_non_linux_load_rejected_before_touching_files(self):
        with mock.patch.object(fixture.sys, "platform", "darwin"):
            with self.assertRaisesRegex(ValueError, "only inside"):
                fixture.require_guest(mock.Mock(root="/not-used", authorization_file=None))

    def test_all_load_handlers_require_guest_before_work(self):
        for command in ("cpu", "mem", "tasks", "disk"):
            arguments = ["--root", "/not-used", command]
            if command == "disk":
                arguments += ["--volume", "volume"]
            args = fixture.parser().parse_args(arguments)
            with self.subTest(command=command):
                with mock.patch.object(fixture, "require_guest", side_effect=ValueError("guard")):
                    with self.assertRaisesRegex(ValueError, "guard"):
                        args.run(args)


class SafeFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = os.path.realpath(self.temporary.name)
        Path(self.root, "volume").mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def test_reject_escaping_or_ambiguous_relative_path(self):
        for value in ("../outside", "/absolute", "a/../b", "./b", "a//b", "a\\b", ""):
            with self.subTest(value=value), self.assertRaises(ValueError):
                fixture.relative_parts(value)

    def test_parent_symlink_cannot_escape_root(self):
        with tempfile.TemporaryDirectory() as outside:
            Path(self.root, "link").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(OSError):
                fixture.write_root_file(self.root, "link/escaped", b"no")
            self.assertFalse(Path(outside, "escaped").exists())

    def test_leaf_symlink_is_rejected_without_modifying_target(self):
        target = Path(self.root, "target")
        target.write_bytes(b"unchanged")
        Path(self.root, "link").symlink_to(target)
        with self.assertRaises(ValueError):
            fixture.write_root_file(self.root, "link", b"no")
        with self.assertRaises(OSError):
            fixture.read_root_file(self.root, "link")
        self.assertEqual(target.read_bytes(), b"unchanged")

    def test_hardlinked_target_is_not_overwritten(self):
        target = Path(self.root, "target")
        target.write_bytes(b"unchanged")
        os.link(target, Path(self.root, "alias"))
        with self.assertRaises(ValueError):
            fixture.write_root_file(self.root, "alias", b"no")
        self.assertEqual(target.read_bytes(), b"unchanged")

    def test_small_file_persists_and_human_edit_is_read(self):
        args = fixture.parser().parse_args(["--root", self.root, "file-persist", "write",
                                            "--path", "volume/canary.txt", "--value", "agent"])
        first = args.run(args)
        self.assertEqual(first["sha256"], hashlib.sha256(b"agent").hexdigest())
        Path(self.root, "volume/canary.txt").write_bytes(b"human")
        args.operation = "read"
        second = args.run(args)
        self.assertEqual(second["sha256"], hashlib.sha256(b"human").hexdigest())
        self.assertEqual(list(Path(self.root, "volume").glob(".fixture-write-*")), [])

    def test_read_bound(self):
        Path(self.root, "large").write_bytes(b"abcd")
        with self.assertRaisesRegex(ValueError, "read bound"):
            fixture.read_root_file(self.root, "large", maximum=3)

    def test_health_single_beat_is_bounded_small_file(self):
        args = fixture.parser().parse_args(["--root", self.root, "health", "--seconds", "0"])
        self.assertEqual(args.run(args)["beats"], 1)
        heartbeat = json.loads(Path(self.root, "control-health.json").read_text())
        self.assertEqual(heartbeat["fixture"], "control-health")

    def test_network_endpoint_count_rejected_without_resolving(self):
        args = mock.Mock(endpoint=["tcp://localhost:1"] * 9)
        with mock.patch.object(fixture.socket, "getaddrinfo") as resolver:
            with self.assertRaisesRegex(ValueError, "eight"):
                fixture.probe_network(args)
            resolver.assert_not_called()

    def test_missing_root_reports_json_error(self):
        output = io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=True), contextlib.redirect_stdout(output):
            code = fixture.main(["inspect"])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output.getvalue())["status"], "error")


if __name__ == "__main__":
    unittest.main()
