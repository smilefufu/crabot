#!/usr/bin/env python3
"""Bounded guest-only payloads shared by sandbox qualification backends.

No load command runs unless Linux and ROOT/.guest-authorization explicitly marks
this as a disposable qualification guest. This is an accident guard, not proof
of a VM/security boundary. The outer runner must enforce OS resource limits.
"""
import argparse
import contextlib
import errno
import hashlib
import json
import os
import signal
import socket
import stat
import sys
import threading
import time
import uuid
from urllib.parse import urlsplit

MIB = 1024 * 1024
MAX_MEMORY = 1536 * MIB
MAX_DISK = 1280 * MIB
MAX_TASKS = 512
MAX_FILE = MIB
MARKER = ".guest-authorization"
MARKER_KIND = "crabot-sandbox-qualification-phase1"


class DeadlineExceeded(Exception):
    pass


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        print(json.dumps({"status": "argument_error", "message": message}), flush=True)
        raise SystemExit(2)


def bounded_int(minimum, maximum):
    def parse(value):
        try:
            number = int(value)
        except ValueError as exc:
            raise argparse.ArgumentTypeError("expected an integer") from exc
        if not minimum <= number <= maximum:
            raise argparse.ArgumentTypeError(f"must be between {minimum} and {maximum}")
        return number
    return parse


def relative_parts(value):
    if not value or os.path.isabs(value):
        raise ValueError("path must be a nonempty path relative to the test root")
    parts = value.split("/")
    if any(p in ("", ".", "..") or "\\" in p or "\x00" in p for p in parts):
        raise ValueError("path contains an unsafe component")
    return parts


@contextlib.contextmanager
def root_fd(root):
    absolute = os.path.abspath(root)
    if os.path.realpath(absolute) != absolute:
        raise ValueError("test root must use its real path without symlink ancestors")
    fd = os.open(absolute, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        yield fd
    finally:
        os.close(fd)


@contextlib.contextmanager
def parent_fd(root, relative):
    parts = relative_parts(relative)
    with root_fd(root) as base:
        current = os.dup(base)
        try:
            for part in parts[:-1]:
                new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                              dir_fd=current)
                os.close(current)
                current = new
            yield current, parts[-1]
        finally:
            os.close(current)


def read_root_file(root, relative, maximum=MAX_FILE):
    with parent_fd(root, relative) as (directory, name):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=directory)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError("target must be a regular file")
            chunks, size = [], 0
            while True:
                chunk = os.read(fd, min(65536, maximum + 1 - size))
                if not chunk:
                    return b"".join(chunks)
                chunks.append(chunk)
                size += len(chunk)
                if size > maximum:
                    raise ValueError("file exceeds the fixture read bound")
        finally:
            os.close(fd)


def write_root_file(root, relative, content):
    if len(content) > MAX_FILE:
        raise ValueError("file exceeds the fixture write bound")
    with parent_fd(root, relative) as (directory, name):
        try:
            existing = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1:
                raise ValueError("target must be a regular file with one link")
        except FileNotFoundError:
            pass
        temporary = ".fixture-write-" + uuid.uuid4().hex
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        try:
            view = memoryview(content)
            while view:
                count = os.write(fd, view)
                if count == 0:
                    raise OSError(errno.EIO, "zero-byte file write")
                view = view[count:]
            os.fsync(fd)
            os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        finally:
            os.close(fd)
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass


def validate_authorization(data, machine_id):
    expected_id = machine_id.strip()
    if (len(expected_id) != 32 or any(c not in "0123456789abcdef" for c in expected_id)
            or data.splitlines() != [MARKER_KIND, expected_id]):
        raise ValueError("authorization marker does not match this qualification guest")


def validate_marker_info(info, allow_unmapped=False, read_only=False, uid_map=""):
    if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or info.st_size > 4096):
        raise ValueError("authorization marker must be a protected regular file")
    if info.st_uid == 0:
        return
    mapping = [line.split() for line in uid_map.splitlines()]
    if (allow_unmapped and info.st_uid == 65534 and read_only
            and mapping in ([["1000", "62001", "1"]], [["1000", "62002", "1"]])):
        return
    raise ValueError("authorization marker must be root-owned or explicitly qualified unmapped root")


def require_guest(args):
    if not sys.platform.startswith("linux"):
        raise ValueError("load payloads run only inside the disposable Linux guest")
    path = args.authorization_file or os.path.join(args.root, MARKER)
    if os.path.realpath(path) != os.path.abspath(path):
        raise ValueError("authorization marker path cannot contain symlinks")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        uid_map, read_only = "", False
        if args.allow_unmapped_root_marker and info.st_uid == 65534:
            read_only = bool(os.fstatvfs(fd).f_flag & os.ST_RDONLY)
            with open("/proc/self/uid_map", encoding="ascii") as source:
                uid_map = source.read(4096)
        validate_marker_info(info, args.allow_unmapped_root_marker, read_only, uid_map)
        data = os.read(fd, 4097).decode("ascii")
    finally:
        os.close(fd)
    with open("/etc/machine-id", encoding="ascii") as source:
        validate_authorization(data, source.read(4096))


@contextlib.contextmanager
def deadline(seconds):
    def expired(_signum, _frame):
        raise DeadlineExceeded()
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def cpu(args):
    require_guest(args)
    stop, counts = threading.Event(), [0] * args.threads
    block = bytes(MIB)
    until = time.monotonic() + args.seconds
    def work(index):
        while not stop.is_set() and time.monotonic() < until:
            # hashlib releases the GIL for inputs larger than 2047 bytes.
            hashlib.sha256(block).digest()
            counts[index] += 1
    workers = [threading.Thread(target=work, args=(i,), daemon=True)
               for i in range(args.threads)]
    started = time.process_time()
    try:
        for worker in workers:
            worker.start()
        while any(worker.is_alive() for worker in workers):
            for worker in workers:
                worker.join(0.05)
    finally:
        stop.set()
        for worker in workers:
            if worker.ident is not None:
                worker.join(0.5)
    return {"status": "ok", "threads": args.threads, "iterations": sum(counts),
            "hash_block_bytes": len(block), "hashed_bytes": sum(counts) * len(block),
            "process_cpu_seconds": time.process_time() - started,
            "note": "SHA-256 uses a fixed input larger than the GIL-release threshold"}


def memory(args):
    require_guest(args)
    blocks, allocated, allocation_error = [], 0, None
    try:
        while allocated < args.bytes:
            size = min(16 * MIB, args.bytes - allocated)
            block = bytearray(size)
            for offset in range(0, size, 4096):
                block[offset] = 0xA5
            blocks.append(block)
            allocated += size
    except MemoryError:
        allocation_error = "MemoryError"
    time.sleep(args.seconds)
    result = {"status": "limit_reached" if allocation_error else "ok",
              "requested_bytes": args.bytes, "allocated_bytes": allocated,
              "allocation_error": allocation_error}
    blocks.clear()
    return result


def tasks(args):
    require_guest(args)
    children, spawn_error = [], None
    try:
        for _ in range(args.count):
            try:
                pid = os.fork()
            except OSError as exc:
                spawn_error = exc.errno
                break
            if pid == 0:
                # No child forks. Each child has its own bounded lifetime.
                signal.setitimer(signal.ITIMER_REAL, min(args.seconds + 1, 31))
                try:
                    time.sleep(args.seconds)
                except DeadlineExceeded:
                    pass
                os._exit(0)
            children.append(pid)
        time.sleep(args.seconds)
        return {"status": "limit_reached" if spawn_error else "ok",
                "requested_tasks": args.count, "created_tasks": len(children),
                "spawn_errno": spawn_error}
    finally:
        for pid in children:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for pid in children:
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass


def disk(args):
    require_guest(args)
    # A directory must be prepared by the runner on the dedicated test volume.
    relative_parts(args.volume)
    name = "fixture-disk-" + uuid.uuid4().hex
    written, write_error = 0, None
    with parent_fd(args.root, args.volume + "/" + name) as (directory, leaf):
        fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        try:
            chunk = bytes(MIB)
            while written < args.bytes:
                count = os.write(fd, chunk[:min(MIB, args.bytes - written)])
                if count == 0:
                    raise OSError(errno.EIO, "zero-byte disk write")
                written += count
            os.fsync(fd)
        except OSError as exc:
            write_error = exc.errno
        finally:
            os.close(fd)
            os.unlink(leaf, dir_fd=directory)
    return {"status": "limit_reached" if write_error else "ok",
            "requested_bytes": args.bytes, "written_bytes": written,
            "write_errno": write_error, "temporary_file_removed": True}


def health(args):
    # The only persistent content is a fixture-owned heartbeat/canary record.
    relative_parts(args.path)
    until, beats = time.monotonic() + args.seconds, 0
    while True:
        beats += 1
        content = json.dumps({"fixture": "control-health", "beats": beats,
                              "monotonic_ns": time.monotonic_ns()}).encode()
        write_root_file(args.root, args.path, content)
        if time.monotonic() >= until:
            break
        time.sleep(0.2)
    return {"status": "ok", "beats": beats, "path": args.path}


def inspect(_args):
    result = {"status": "ok", "platform": sys.platform, "pid": os.getpid(),
              "uid": os.getuid(), "gid": os.getgid()}
    if not sys.platform.startswith("linux"):
        return result
    with open("/proc/self/cgroup", encoding="utf-8") as source:
        result["cgroup"] = source.read(16384).splitlines()
    result["namespaces"] = {}
    for name in ("mnt", "pid", "net", "user", "ipc", "uts", "cgroup"):
        try:
            result["namespaces"][name] = os.readlink("/proc/self/ns/" + name)
        except OSError:
            result["namespaces"][name] = None
    selected = {"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs",
                "Seccomp", "Seccomp_filters", "NSpid", "Threads"}
    with open("/proc/self/status", encoding="utf-8") as source:
        result["process_status"] = {key: value.strip() for line in source
                                    if ":" in line
                                    for key, value in [line.split(":", 1)]
                                    if key in selected}
    return result


def endpoint(value):
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise argparse.ArgumentTypeError("endpoint has an invalid port") from exc
    if (parsed.scheme != "tcp" or not parsed.hostname or port is None or port < 1
            or parsed.username or parsed.password or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment or len(parsed.hostname) > 253):
        raise argparse.ArgumentTypeError("expected explicit tcp://host:port endpoint")
    return value


def probe_network(args):
    if len(args.endpoint) > 8:
        raise ValueError("at most eight explicit endpoints are allowed")
    results = []
    for value in args.endpoint:
        parsed, attempts = urlsplit(value), []
        try:
            addresses = socket.getaddrinfo(parsed.hostname, parsed.port,
                                           type=socket.SOCK_STREAM)
            seen = set()
            for family, socktype, protocol, _, address in addresses:
                key = (family, address)
                if key in seen:
                    continue
                seen.add(key)
                if len(attempts) == 4:
                    break
                try:
                    with socket.socket(family, socktype, protocol) as connection:
                        connection.settimeout(1.0)
                        connection.connect(address)
                    attempts.append({"address": address[0], "connected": True})
                except OSError as exc:
                    attempts.append({"address": address[0], "connected": False,
                                     "errno": exc.errno,
                                     "timeout": isinstance(exc, TimeoutError)})
            results.append({"endpoint": value, "attempts": attempts})
        except socket.gaierror as exc:
            results.append({"endpoint": value, "dns_errno": exc.errno})
    return {"status": "ok", "results": results,
            "note": "TCP connection only; no requests, scanning, or redirects"}


def probe_paths(args):
    if len(args.path) > 8:
        raise ValueError("at most eight explicit paths are allowed")
    results = []
    for path in args.path:
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
            try:
                regular = stat.S_ISREG(os.fstat(fd).st_mode)
                if regular:
                    os.read(fd, 1)  # Prove readability without reporting content.
                results.append({"path": path, "readable": regular,
                                "regular_file": regular})
            finally:
                os.close(fd)
        except OSError as exc:
            results.append({"path": path, "readable": False, "errno": exc.errno})
    return {"status": "ok", "results": results}


def file_persist(args):
    relative_parts(args.path)
    if args.operation == "write":
        if args.value is None or len(args.value.encode()) > 65536:
            raise ValueError("write requires a value of at most 65536 UTF-8 bytes")
        write_root_file(args.root, args.path, args.value.encode())
    content = read_root_file(args.root, args.path)
    return {"status": "ok", "path": args.path, "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest()}


def parser():
    result = JsonArgumentParser(description=__doc__)
    result.add_argument("--root", default=os.environ.get("CRABOT_QUAL_ROOT"))
    result.add_argument("--authorization-file", help="explicit protected read-only guest marker")
    result.add_argument("--allow-unmapped-root-marker", action="store_true",
                        help="qualify read-only overflow-UID marker in the fixed NsJail UID maps")
    result.add_argument("--deadline-seconds", type=bounded_int(1, 60), default=45)
    commands = result.add_subparsers(dest="command", required=True)
    load_cpu = commands.add_parser("cpu")
    load_cpu.add_argument("--threads", type=bounded_int(1, 2), default=1)
    load_cpu.add_argument("--seconds", type=bounded_int(1, 30), default=5)
    load_cpu.set_defaults(run=cpu)
    mem = commands.add_parser("mem")
    mem.add_argument("--bytes", type=bounded_int(1, MAX_MEMORY), default=64 * MIB)
    mem.add_argument("--seconds", type=bounded_int(1, 30), default=2)
    mem.set_defaults(run=memory)
    finite = commands.add_parser("tasks")
    finite.add_argument("--count", type=bounded_int(1, MAX_TASKS), default=16)
    finite.add_argument("--seconds", type=bounded_int(1, 30), default=5)
    finite.set_defaults(run=tasks)
    volume = commands.add_parser("disk")
    volume.add_argument("--volume", required=True)
    volume.add_argument("--bytes", type=bounded_int(1, MAX_DISK), default=64 * MIB)
    volume.set_defaults(run=disk)
    control = commands.add_parser("health")
    control.add_argument("--path", default="control-health.json")
    control.add_argument("--seconds", type=bounded_int(0, 30), default=0)
    control.set_defaults(run=health)
    commands.add_parser("inspect").set_defaults(run=inspect)
    network = commands.add_parser("probe-network")
    network.add_argument("--endpoint", type=endpoint, action="append", required=True)
    network.set_defaults(run=probe_network)
    paths = commands.add_parser("probe-paths")
    paths.add_argument("--path", action="append", required=True)
    paths.set_defaults(run=probe_paths)
    persist = commands.add_parser("file-persist")
    persist.add_argument("operation", choices=("write", "read"))
    persist.add_argument("--path", required=True)
    persist.add_argument("--value")
    persist.set_defaults(run=file_persist)
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    started = time.monotonic()
    try:
        if not args.root:
            raise ValueError("--root or CRABOT_QUAL_ROOT is required")
        with root_fd(args.root):
            pass
        with deadline(args.deadline_seconds):
            output = args.run(args)
        code = 0 if output["status"] == "ok" else 3
    except DeadlineExceeded:
        output, code = {"status": "deadline_exceeded"}, 124
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        output, code = {"status": "error", "error_type": type(exc).__name__,
                        "errno": getattr(exc, "errno", None), "message": str(exc)}, 2
    output.update(command=args.command, elapsed_seconds=round(time.monotonic() - started, 4))
    print(json.dumps(output, sort_keys=True), flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
