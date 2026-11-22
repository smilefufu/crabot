"""Operate only the dedicated qualification VM with a minimal inherited environment."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

NAME = "qualification"
IMAGE_SHA = "50e24e1fb79e89116e939d90aa7738f7af48c442fa1bc2510131e0b39c50348e"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("action", choices=["create", "start", "stop", "list", "shell", "copy"])
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    runtime = args.runtime
    if runtime.is_symlink() or runtime.absolute() != runtime.resolve():
        raise SystemExit("Runtime must be a canonical non-symlink path")
    runtime.mkdir(mode=0o700, exist_ok=True)
    if runtime.stat().st_uid != os.getuid() or runtime.stat().st_mode & 0o077:
        raise SystemExit("Runtime must be private and owned by this user")
    owner = runtime / "qualification-task.json"
    identity = {"task_root": str(root), "instance": NAME, "lima_version": "2.3.0"}
    if args.action == "create":
        if owner.exists() or (runtime / NAME).exists():
            raise SystemExit("Runtime already has an instance or owner; inspect it first")
        with owner.open("x") as stream:
            json.dump(identity, stream)
        owner.chmod(0o600)
    elif (owner.is_symlink() or not owner.is_file()
          or owner.stat().st_uid != os.getuid() or owner.stat().st_mode & 0o077
          or json.loads(owner.read_text()) != identity):
        raise SystemExit("Runtime is not bound to this qualification task")
    environment = {key: os.environ[key] for key in ("HOME", "USER", "LOGNAME", "TMPDIR") if key in os.environ}
    environment.update(PATH="/usr/bin:/bin:/usr/sbin:/sbin", LANG="C.UTF-8",
                       LIMA_HOME=str(runtime), LIMA_CACHE_HOME=str(root / "cache/lima"))
    executable = root / "tools/lima-2.3.0/bin/limactl"
    command = [str(executable), "--tty=false", args.action]
    if args.action == "create":
        if args.arguments:
            raise SystemExit("Create does not accept parameter overrides")
        image = root / "downloads/ubuntu-24.04-server-cloudimg-arm64.img"
        with image.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != IMAGE_SHA:
                raise SystemExit("Refusing an unverified Ubuntu image")
        config = Path(__file__).with_name("lima.yaml")
        command += ["--name=" + NAME, "--mount-none", "--set=.images[0].location = " + json.dumps(str(image)), str(config)]
    elif args.action in ("start", "stop"):
        if args.arguments:
            raise SystemExit("Lifecycle actions do not accept overrides")
        command += [NAME]
    elif args.action == "shell":
        guest = args.arguments[1:] if args.arguments[:1] == ["--"] else args.arguments
        if not guest:
            raise SystemExit("A guest command is required")
        command += ["--workdir=/tmp", NAME, "--", *guest]
    elif args.action == "list":
        if args.arguments:
            raise SystemExit("List does not accept overrides")
        command += ["--json"]
    else:
        if len(args.arguments) != 2:
            raise SystemExit("Copy requires exactly two task paths")
        source, target = args.arguments
        from_vm, to_vm = source.startswith(NAME + ":"), target.startswith(NAME + ":")
        if from_vm == to_vm:
            raise SystemExit("Copy requires exactly one qualification VM endpoint")
        local = Path(target if from_vm else source)
        if ":" in str(local) or not local.is_absolute():
            raise SystemExit("The other copy endpoint must be an absolute local path")
        resolved = local.resolve(strict=not from_vm)
        allowed = [root / "evidence"] if from_vm else [root / "input", root / "downloads"]
        if not any(resolved.is_relative_to(directory) for directory in allowed):
            raise SystemExit("Copy must use this task's input/downloads or evidence directory")
        command += [source, target]
    raise SystemExit(subprocess.run(command, env=environment, cwd=root).returncode)


if __name__ == "__main__":
    main()
