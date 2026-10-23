"""Finite fixture test. --inspect never modifies AppArmor; no GUI/Polkit claim."""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

helper = str(Path(sys.argv[1]).resolve())
assert os.getuid() != 0
sha = lambda b: hashlib.sha256(b).hexdigest()
encode = lambda obj: (json.dumps(obj, separators=(',', ':'), ensure_ascii=False) + '\n').encode()
with tempfile.TemporaryDirectory(prefix='Crabot namespace 用户 *?[]{}@{HOME} \\" ', dir=Path.home()) as tmp:
    root = Path(tmp)
    ident, gui = str(uuid.uuid4()), str(uuid.uuid4())
    version = '0.1.0-test'
    # ELF header sufficient for fixture identity; never executed by the helper.
    binary = bytearray(64)
    binary[:6] = b'\x7fELF\x02\x01'
    binary[18] = 62
    entry = {'size': len(binary), 'sha256': sha(binary)}
    chromium = '.scrapling-runtime-0123456789abcdef/browsers/chromium-1234/chrome-linux64/chrome'
    headless = '.scrapling-runtime-0123456789abcdef/browsers/chromium_headless_shell-1234/chrome-headless-shell-linux64/headless_shell'
    runtime = {'schema_version': 1, 'version': version, 'platform': 'linux', 'arch': 'x64',
               'browser': '.scrapling-runtime-0123456789abcdef/chromium-launcher', 'files': {chromium: entry, headless: entry}}
    files = {'product-runtime.json': {'type': 'file', 'size': len(encode(runtime)), 'sha256': sha(encode(runtime))},
             chromium: {'type': 'file', **entry}, headless: {'type': 'file', **entry}}
    index = {'schema_version': 1, 'files': files}
    core = sha(encode(index))
    selection = {'schema_version': 1, 'version': version, 'gui_id': gui, 'core_id': core}
    metadata = {'schema_version': 1, 'installation_id': ident, 'owner': str(os.getuid()), 'install_root': tmp,
                'root_identity': {'dev': str(root.stat().st_dev), 'ino': str(root.stat().st_ino)},
                'paths': {'app': 'app/releases', 'core': 'releases', 'data': 'data', 'bin': 'bin'}}
    payload = {'schema_version': 1, 'platform': 'linux', 'arch': 'x64', 'selection': selection,
               'gui': {'crabot-desktop': {'type': 'file', 'mode': 493, **entry}}}
    pending = {'schema_version': 1, 'id': str(uuid.uuid4()), 'installation_id': ident, 'selection': selection,
               'phase': 'prepared', 'payload_sha256': sha(encode(payload))}

    def put(relative, content, mode=0o600):
        p = root / relative
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(encode(content) if isinstance(content, dict) else content)
        p.chmod(mode)
        return p

    def run(ok=True, option='--inspect', target=tmp):
        result = subprocess.run([helper, option, target], capture_output=True, text=True, timeout=10)
        assert (result.returncode == 0) == ok, (result.returncode, result.stderr)
        if ok:
            assert result.stdout.count('  userns,') == 3
            assert 'CRABOT_SANDBOX_VERIFIED' in result.stdout
        else:
            assert 'CRABOT_SANDBOX_NOT_READY:' in result.stderr
        return result

    put('desktop-installation.json', metadata)
    state_file = put('.desktop-installing.json', pending)
    put('.desktop-install-payload.json', payload)
    put(f'app/releases/{gui}/resources/desktop-release.json', selection)
    gui_file = put(f'app/releases/{gui}/crabot-desktop', binary, 0o755)
    put(f'releases/{core}/core-release.json', {'schema_version': 1, 'version': version, 'inventory_sha256': core, 'platform': 'linux', 'arch': 'x64'})
    put(f'releases/{core}/core-files.json', index)
    runtime_file = put(f'releases/{core}/product-runtime.json', runtime)
    chrome_file = put(f'releases/{core}/{chromium}', binary, 0o755)
    put(f'releases/{core}/{headless}', binary, 0o755)
    # Business directories deliberately absent. Helper must not need/read them.
    output = run().stdout
    assert '\\x2a\\x3f\\x5b\\x5d\\x7b\\x7d\\x40\\x7bHOME\\x7d' in output
    assert '\\x5c\\x22' in output
    run(False, '--register')
    run(False, '--inspect', tmp + '/..')
    with tempfile.TemporaryDirectory(dir=Path.home()) as other:
        alias = Path(other) / 'alias'
        alias.symlink_to(root, target_is_directory=True)
        run(False, target=str(alias))
    saved = copy.deepcopy(pending)
    for key, value in [('phase', 'preparing'), ('installation_id', str(uuid.uuid4())), ('payload_sha256', '0' * 64)]:
        changed = copy.deepcopy(saved)
        changed[key] = value
        put('.desktop-installing.json', changed)
        run(False)
    put('.desktop-installing.json', saved)
    state_file.chmod(0o644)
    run(False)
    state_file.chmod(0o600)
    state_file.write_text('{"schema_version":1,"schema_version":1}')
    run(False)
    put('.desktop-installing.json', saved)
    original = gui_file.read_bytes()
    gui_file.write_bytes(original + b'changed')
    run(False)
    gui_file.write_bytes(original)
    gui_file.chmod(0o775)
    run(False)
    gui_file.chmod(0o755)
    link = gui_file.with_name('hard-link')
    os.link(gui_file, link)
    run(False)
    link.unlink()
    gui_file.unlink()
    gui_file.symlink_to(chrome_file)
    run(False)
    gui_file.unlink()
    put(f'app/releases/{gui}/crabot-desktop', binary, 0o755)
    runtime_file.write_bytes(encode({**runtime, 'browser': '/usr/bin/node'}))
    run(False)
    put(f'releases/{core}/product-runtime.json', runtime)
    run()
print('Native helper identity, closed roles, path literals and rejection fixtures passed; no system authorization performed.')
