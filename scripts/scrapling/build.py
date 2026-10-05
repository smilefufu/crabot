"""Seal portable Python/browser resources; no host package installation required."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import site
import ssl
import subprocess
import sys
import urllib.request

runtime = Path(sys.argv[1]).resolve()
inputs = Path(sys.argv[2])
BASE_LIBRARIES = {"libc.so.6", "libm.so.6", "libdl.so.2", "libpthread.so.0", "librt.so.1", "libresolv.so.2", "libutil.so.1", "libanl.so.1", "libgcc_s.so.1", "libstdc++.so.6"}


def linux_resources():
    arch = "arm64" if os.uname().machine == "aarch64" else "x64"
    resources = json.loads((inputs / "linux-resources.json").read_text())[arch]
    extracted = runtime / ".linux-download"
    extracted.mkdir()
    import certifi
    certificates = ssl.create_default_context(cafile=certifi.where())
    for package in resources:
        print(f"Scrapling native resource: {package['package']} {package['version']}", flush=True)
        archive = extracted / (package["package"] + ".deb")
        url = package["url"].replace("http://", "https://", 1)
        digest = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=120, context=certificates) as response, archive.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
        if digest.hexdigest() != package["sha256"]:
            raise RuntimeError(f"Linux resource checksum failed: {package['package']}")
        subprocess.run(["dpkg-deb", "-x", str(archive), str(extracted)], check=True, timeout=60)
        archive.unlink()
    libraries = runtime / "lib"
    libraries.mkdir()
    # 包括 NSS 的 dlopen 模块和 .chk，不只采集 ldd 的直接依赖。
    for file in sorted(extracted.rglob("*")):
        if not file.is_file() or not (".so" in file.name or file.suffix == ".chk"):
            continue
        if file.name in BASE_LIBRARIES or file.name.startswith("ld-linux-"):
            continue
        target = libraries / file.name
        if target.exists() and target.read_bytes() != file.read_bytes():
            raise RuntimeError(f"Conflicting Linux library: {file.name}")
        shutil.copyfile(file, target)
    for name in ("libsoftokn3.so", "libfreeblpriv3.so", "libsqlite3.so.0"):
        if not (libraries / name).exists():
            raise RuntimeError(f"Missing NSS runtime module: {name}")
    shutil.copytree(extracted / "usr/share/fonts/truetype", runtime / "fonts")
    licenses = runtime / "licenses/linux"
    licenses.mkdir(parents=True)
    for package in resources:
        source = extracted / "usr/share/doc" / package["package"] / "copyright"
        if source.is_file():
            shutil.copyfile(source, licenses / (package["package"] + ".txt"))
    (runtime / "linux-sources.json").write_text(json.dumps(resources, indent=2) + "\n")
    (runtime / "fonts.conf").write_text('<?xml version="1.0"?><fontconfig><dir prefix="relative">fonts</dir><cachedir prefix="xdg">fontconfig</cachedir><alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias></fontconfig>\n')
    shutil.rmtree(extracted)


def launcher(name, executable):
    target = runtime / name
    relative = executable.relative_to(runtime).as_posix()
    target.write_text('#!/bin/sh\nset -eu\nruntime=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport LD_LIBRARY_PATH="$runtime/lib:$runtime/python/lib"\nexec "$runtime/' + relative + '" "$@"\n')
    target.chmod(0o755)
    return target


if sys.platform == "linux":
    linux_resources()
    os.environ["LD_LIBRARY_PATH"] = str(runtime / "lib") + ":" + str(runtime / "python/lib")
from playwright.sync_api import sync_playwright
with sync_playwright() as playwright:
    browser = Path(playwright.chromium.executable_path)
if not browser.is_file():
    raise RuntimeError("Chromium download incomplete")
node = runtime / "packages/playwright/driver" / ("node.exe" if sys.platform == "win32" else "node")
python = runtime / "python" / ("python.exe" if sys.platform == "win32" else "bin/python3.12")
if sys.platform == "linux":
    browser = launcher("chromium-launcher", browser)
    node = launcher("node-launcher", node)
    python = launcher("python-launcher", python)
    subprocess.run([str(browser), "--version"], check=True, timeout=30)

# 校验导入与版本；BrowserForge 指纹数据已作为包资源随依赖安装，不现场下载。
import importlib.metadata
if sys.platform == "win32":
    site.addsitedir(str(runtime / "packages"))
from scrapling.core.ai import ScraplingMCPServer
versions = json.loads((inputs / "runtime.json").read_text())
for package in ("scrapling", "mcp", "playwright", "patchright"):
    if importlib.metadata.version(package) != versions[package]:
        raise RuntimeError(f"Unexpected {package} version")
shutil.rmtree(runtime / "browsers/.links", ignore_errors=True)
for cache in runtime.rglob("__pycache__"):
    shutil.rmtree(cache)
if sys.platform != "win32":
    runtime.chmod(0o755)
    for directory in runtime.rglob("*"):
        if directory.is_dir() and not directory.relative_to(runtime).as_posix().startswith("."):
            directory.chmod(0o755)
files = {}
for file in sorted(runtime.rglob("*")):
    relative = file.relative_to(runtime).as_posix()
    if relative.startswith(".") or not file.is_file():
        continue
    # Linux release root 只读共享，调用进程不回写包和浏览器。
    if sys.platform != "win32":
        file.chmod(0o755 if file.stat().st_mode & 0o111 else 0o644)
    files[relative] = {"size": file.stat().st_size, "sha256": hashlib.file_digest(file.open("rb"), "sha256").hexdigest()}
manifest = {"files": files, "versions": versions, "command": python.relative_to(runtime).as_posix(), "browser": browser.relative_to(runtime).as_posix(), "node": node.relative_to(runtime).as_posix()}
(runtime / "inventory.json").write_text(json.dumps(manifest, indent=2) + "\n")
