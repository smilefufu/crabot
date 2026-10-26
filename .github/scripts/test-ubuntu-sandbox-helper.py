"""Finite fixture test. --inspect never modifies AppArmor; no GUI/Polkit claim."""
import argparse
import copy
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('helper')
parser.add_argument('namespace_probe', nargs='?')
parser.add_argument('--without-headless', action='store_true')
args = parser.parse_args()
helper = str(Path(args.helper).resolve())
role_count = 2 if args.without_headless else 3
assert os.getuid() != 0
sha = lambda b: hashlib.sha256(b).hexdigest()
encode = lambda obj: (json.dumps(obj, separators=(',', ':'), ensure_ascii=False) + '\n').encode()
with tempfile.TemporaryDirectory(prefix='Crabot namespace 用户 *?[]{}@{HOME} \\" ', dir=Path.home()) as parent, tempfile.TemporaryDirectory(prefix='安装 ', dir=parent) as tmp:
    root = Path(tmp)
    ident, gui = str(uuid.uuid4()), str(uuid.uuid4())
    version = '0.1.0-test'
    # ELF header sufficient for fixture identity; never executed by the helper.
    binary = bytearray(Path(args.namespace_probe).read_bytes()) if args.namespace_probe else bytearray(64)
    binary[:6] = b'\x7fELF\x02\x01'
    binary[18] = 62
    entry = {'size': len(binary), 'sha256': sha(binary)}
    chromium = '.scrapling-runtime-desktop-dev-0123456789abcdef-12345678/browsers/chromium-1234/chrome-linux64/chrome'
    headless = '.scrapling-runtime-desktop-dev-0123456789abcdef-12345678/browsers/chromium_headless_shell-1234/chrome-headless-shell-linux64/headless_shell'
    runtime = {'schema_version': 1, 'version': version, 'platform': 'linux', 'arch': 'x64',
               'browser': '.scrapling-runtime-desktop-dev-0123456789abcdef-12345678/chromium-launcher', 'files': {chromium: entry, headless: entry}}
    pointer = {'directory': '.scrapling-runtime-desktop-dev-0123456789abcdef-12345678'}
    if args.without_headless:
        del runtime['files'][headless]
    files = {'scrapling-runtime.json': {'type': 'file', 'size': len(encode(pointer)), 'sha256': sha(encode(pointer))},
             'product-runtime.json': {'type': 'file', 'size': len(encode(runtime)), 'sha256': sha(encode(runtime))},
             chromium: {'type': 'file', **entry}, headless: {'type': 'file', **entry}}
    if args.without_headless:
        del files[headless]
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

    def run(ok=True, option='--inspect', target=tmp, update_gui=None):
        command = [helper, option, target] + ([] if update_gui is None else [update_gui])
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        assert (result.returncode == 0) == ok, (result.returncode, result.stderr)
        if ok:
            assert result.stdout.count('  userns,') == role_count
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
    put(f'releases/{core}/scrapling-runtime.json', pointer)
    chrome_file = put(f'releases/{core}/{chromium}', binary, 0o755)
    if not args.without_headless:
        put(f'releases/{core}/{headless}', binary, 0o755)
    # Business directories deliberately absent. Helper must not need/read them.
    output = run().stdout
    # Existing installation roots retain readable/traversable permissions. The
    # helper verifies ownership and no foreign writes, never chmods the root.
    root.chmod(0o755)
    assert run().stdout == output
    assert root.stat().st_mode & 0o7777 == 0o755
    root.chmod(0o777)
    run(False)
    assert root.stat().st_mode & 0o7777 == 0o777
    root.chmod(0o700)
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
    parent_mode = Path(parent).stat().st_mode & 0o777
    try:
        Path(parent).chmod(0o777)
        run(False)  # Private root alone cannot protect a writable ancestor.
    finally:
        Path(parent).chmod(parent_mode)
    run()
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
    # An update reads only the existing installation, current pair and exact
    # prepared GUI-id proof. It cannot reuse a fresh-install pending marker.
    next_gui = str(uuid.uuid4())
    next_selection = {**selection, 'gui_id': next_gui}
    next_payload = {**payload, 'selection': next_selection}
    update_proof = put(f'app/payloads/{next_gui}.json', next_payload)
    next_gui_file = put(f'app/releases/{next_gui}/crabot-desktop', binary, 0o755)
    next_pin = put(f'app/releases/{next_gui}/resources/desktop-release.json', next_selection)
    current_file = put('current-release.json', selection)
    run(False, '--inspect-update', update_gui=next_gui)  # Fresh marker is still present.
    state_file.unlink()
    update_output = run(option='--inspect-update', update_gui=next_gui).stdout
    run(False)  # Missing fresh marker is never treated as a new installation.
    run(False, '--register-update', update_gui=next_gui)
    for bad in ['../escape', 'not-a-uuid', gui]:
        run(False, '--inspect-update', update_gui=bad)
    update_proof.chmod(0o644)
    run(False, '--inspect-update', update_gui=next_gui)
    update_proof.chmod(0o600)
    current_file.unlink()
    run(False, '--inspect-update', update_gui=next_gui)
    put('current-release.json', {**selection, 'gui_id': str(uuid.uuid4())})
    run(False, '--inspect-update', update_gui=next_gui)
    put('current-release.json', selection)
    put(f'app/releases/{next_gui}/resources/desktop-release.json', selection)
    run(False, '--inspect-update', update_gui=next_gui)
    put(f'app/releases/{next_gui}/resources/desktop-release.json', next_selection)
    run(option='--inspect-update', update_gui=next_gui)
    put('.desktop-installing.json', saved)
    if args.namespace_probe:
        restriction = Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
        assert restriction.read_text().strip() == '1', 'Kernel restriction is required for this acceptance'
        original_setting = restriction.read_bytes()
        before_code = subprocess.run([str(gui_file)], timeout=5).returncode
        if before_code != 13:
            print('KERNEL_PRECONDITION', json.dumps({'code': before_code, 'restriction': original_setting.decode().strip(),
                'kernel': os.uname().release, 'apparmor_enabled': Path('/sys/module/apparmor/parameters/enabled').read_text().strip(),
                'caller_context': Path('/proc/self/attr/current').read_text().strip(),
                'caller_status': [line for line in Path('/proc/self/status').read_text().splitlines() if line.startswith(('Uid:', 'CapEff:', 'NoNewPrivs:', 'Seccomp:'))]}), flush=True)
        assert before_code == 13, 'Fixture must actually be denied before registration'
        names = [line for line in output.splitlines() if re.fullmatch(r'crabot-[a-z0-9-]+', line)]
        assert len(names) == role_count
        policies = [Path('/etc/apparmor.d') / name for name in names]
        assert not any(file.exists() for file in policies)
        try:
            subprocess.run(['/usr/bin/sudo', '/usr/bin/env', 'PKEXEC_UID=' + str(os.getuid()), helper, '--register', tmp], check=True, timeout=120)
            for executable in [gui_file, chrome_file] + ([] if args.without_headless else [root / f'releases/{core}/{headless}']):
                assert subprocess.run([str(executable)], timeout=5).returncode == 0, 'Exact role must receive namespace permission'
            neighbor = gui_file.with_name('unregistered-neighbor')
            neighbor.write_bytes(binary)
            neighbor.chmod(0o755)
            assert subprocess.run([str(neighbor)], timeout=5).returncode == 13, 'Other executable must remain denied'
            # Equal existing rules are idempotent, not replaced.
            identities = [(file.stat().st_dev, file.stat().st_ino, file.read_bytes()) for file in policies]
            subprocess.run(['/usr/bin/sudo', '/usr/bin/env', 'PKEXEC_UID=' + str(os.getuid()), helper, '--register', tmp], check=True, timeout=120)
            assert identities == [(file.stat().st_dev, file.stat().st_ino, file.read_bytes()) for file in policies]
            # Updating adds the exact new GUI rule before any stop. Shared
            # browser rules and all old GUI rules retain their original identity.
            state_file.unlink()
            old_policies = list(policies)
            for name in re.findall(r'^(crabot-[a-z0-9-]+)$', update_output, re.M):
                policy = Path('/etc/apparmor.d') / name
                if policy not in policies:
                    policies.append(policy)
            subprocess.run(['/usr/bin/sudo', '/usr/bin/env', 'PKEXEC_UID=' + str(os.getuid()), helper, '--register-update', tmp, next_gui], check=True, timeout=120)
            assert identities == [(file.stat().st_dev, file.stat().st_ino, file.read_bytes()) for file in old_policies]
            assert subprocess.run([str(gui_file)], timeout=5).returncode == 0
            assert subprocess.run([str(next_gui_file)], timeout=5).returncode == 0
            assert subprocess.run([str(neighbor)], timeout=5).returncode == 13
            assert restriction.read_bytes() == original_setting
            print('CRABOT_KERNEL_NAMESPACE_ACCEPTANCE: actual denial -> exact roles allowed; neighbor denied; global setting unchanged; no GUI/Polkit claim')
        finally:
            # All test executables above exited; preserve unknown or changed rules.
            for file in policies:
                if file.exists():
                    expected = next(text for name, text in re.findall(r'(crabot-[a-z0-9-]+)\n(.*?\n}\n)', output + update_output, re.S) if name == file.name)
                    assert file.stat().st_uid == 0 and file.stat().st_nlink == 1 and file.read_text() == expected
                    subprocess.run(['/usr/bin/sudo', '/usr/sbin/apparmor_parser', '-R', '-T', '-K', '--', str(file)], check=True, timeout=90)
                    subprocess.run(['/usr/bin/sudo', '/usr/bin/rm', '--', str(file)], check=True, timeout=5)
print('Native helper identity, closed roles, path literals and rejection fixtures passed; ' +
      ('isolated CI root registration exercised; graphical Polkit not tested.' if args.namespace_probe else 'no system registration performed.'))
