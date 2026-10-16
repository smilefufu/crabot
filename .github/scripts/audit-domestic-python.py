import hashlib
import http.server
import os
from pathlib import Path
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import threading

repo = Path(sys.argv[1]).resolve()
uv = sys.argv[2]
source = repo / 'crabot-memory'
root = Path(tempfile.mkdtemp(prefix='crabot-cn-lock-audit-'))
project = root / 'home 空' / 'crabot-memory'
project.mkdir(parents=True)
for name in ['pyproject.toml', 'uv.lock']:
    shutil.copy2(source / name, project / name)
shutil.copytree(source / 'src', project / 'src')
lock_hash = hashlib.sha256((project / 'uv.lock').read_bytes()).hexdigest()
hosts = []
class Proxy(http.server.BaseHTTPRequestHandler):
    def do_CONNECT(self):
        host, port = self.path.rsplit(':', 1)
        hosts.append(host)
        if host != 'mirrors.aliyun.com':
            self.send_error(403, 'official origins blocked for audit')
            return
        try:
            upstream = socket.create_connection((host, int(port)), timeout=15)
        except OSError:
            self.send_error(502)
            return
        self.send_response(200, 'Connection Established')
        self.end_headers()
        try:
            while True:
                ready, _, _ = select.select([self.connection, upstream], [], [], 30)
                if not ready:
                    break
                for stream in ready:
                    data = stream.recv(65536)
                    if not data:
                        return
                    (upstream if stream is self.connection else self.connection).sendall(data)
        finally:
            upstream.close()
    def log_message(self, *args):
        pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
env = {key: value for key, value in os.environ.items() if not key.startswith('UV_') and key.lower() not in ['https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']}
proxy_url = f'http://127.0.0.1:{server.server_port}'
env.update(HTTPS_PROXY=proxy_url, HTTP_PROXY=proxy_url, ALL_PROXY=proxy_url, NO_PROXY='localhost,127.0.0.1',
           UV_CACHE_DIR=str(root / 'empty-cache'), UV_PYTHON_DOWNLOADS='never', UV_NO_PROGRESS='1', UV_NO_CONFIG='1')
python = str(project / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python'))
pin = sys.executable + '\n'
(project / '.python-version').write_text(pin, encoding='utf-8')
def run(stage, args, expected_success=True):
    result = subprocess.run([uv, *args], cwd=project, env=env, text=True, capture_output=True, timeout=180)
    (root / (stage + '.log')).write_text(result.stdout + result.stderr)
    if expected_success:
        assert result.returncode == 0, result.stderr
    else:
        assert result.returncode != 0, 'unexpected baseline success'
    print(f'{stage}: exit={result.returncode}', flush=True)
    return result
try:
    import json
    driver = root / 'prepare.mjs'
    module = (repo / 'scripts/lib/memory-deps.mjs').as_uri()
    driver.write_text('import { prepareMemoryDependencies } from ' + json.dumps(module) + '; await prepareMemoryDependencies(process.argv[2], { uv: process.argv[3] });')
    result = subprocess.run(['node', str(driver), str(project), uv], cwd=project, env=env, text=True, capture_output=True, timeout=1200)
    (root / 'prepare.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'mirrors.aliyun.com' in result.stdout
    assert (project / '.python-version').read_text(encoding='utf-8') == pin
    interpreter = subprocess.check_output([python, '-c', 'import sys; print(sys.version_info[:2])'], text=True).strip()
    assert interpreter == str(sys.version_info[:2]), interpreter
    print('Explicit Python pin retained; installed interpreter and version file unchanged', flush=True)
    run('prod-frozen-offline', ['run', '--frozen', '--no-dev', '--offline', 'python', '-c', 'import src.main; print("memory import OK")'])
    (project / 'uv.toml').write_text('offline=true\n')
    env.pop('UV_NO_CONFIG')
    requests_before = len(hosts)
    result = subprocess.run(['node', str(driver), str(project), uv], cwd=project, env=env, text=True, capture_output=True, timeout=1200)
    assert result.returncode == 0, result.stdout + result.stderr
    assert len(hosts) == requests_before and (project / 'uv.toml').read_text() == 'offline=true\n'
    print('Configured offline Memory preparation: frozen sync/import, no availability or registry requests', flush=True)
    (project / 'uv.toml').unlink()
    env['UV_NO_CONFIG'] = '1'

    (project / 'uv.toml').write_text('[[index]]\nname="private"\nurl="https://private.invalid/simple"\ndefault=true\n')
    env.pop('UV_NO_CONFIG')
    run('prod-user-index-offline', ['run', '--frozen', '--no-dev', '--offline', 'python', '-c', 'import src.main'])
    (project / 'uv.toml').unlink()
    env['UV_NO_CONFIG'] = '1'
    baseline = run('existing-start-entry', ['run', '--frozen', '--offline', 'python', '-c', 'import src.main'], expected_success=False)
    assert 'pytest' in baseline.stderr, baseline.stderr
    (project / 'upgrade').mkdir()
    migration = project / 'upgrade' / 'encoding-fixture.py'
    migration.write_text('import sys; print(sys.argv[1]); print(chr(0x7a7a))')
    bad_encoding = subprocess.run([uv, 'run', '--frozen', '--no-dev', 'python', str(migration), '--data-dir=' + str(root / 'data 空')], cwd=project, env=env | {'UV_OFFLINE': '1', 'PYTHONIOENCODING': 'cp1252'}, text=True, capture_output=True, timeout=30)
    assert bad_encoding.returncode != 0 and 'UnicodeEncodeError' in bad_encoding.stderr, bad_encoding.stderr
    migration_driver = root / 'migration.mjs'
    runner = (repo / 'scripts/upgrade-lib/runner.mjs').as_uri()
    migration_driver.write_text('import {runScript} from ' + json.dumps(runner) + ';const r=await runScript(process.argv[2],process.argv[3]);if(r.exitCode!==0||!r.stdout.includes("空")||process.env.PYTHONIOENCODING!=="cp1252")process.exit(1);', encoding='utf-8')
    result = subprocess.run(['node', str(migration_driver), str(migration), str(root / 'data 空')], env=env | {'UV_OFFLINE': '1', 'PYTHONIOENCODING': 'cp1252', 'CRABOT_DEV': '1'}, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    print('Actual Memory migration: offline/no-dev and UTF-8 despite inherited cp1252; parent encoding unchanged', flush=True)
    assert hashlib.sha256((project / 'uv.lock').read_bytes()).hexdigest() == lock_hash
    assert hosts and set(hosts) == {'mirrors.aliyun.com'}, str(set(hosts))
    print('Actual Memory: cold domestic download, frozen hash/versions, production offline import OK', flush=True)
    print(f'HTTPS CONNECT hosts: {sorted(set(hosts))}; lock SHA256: {lock_hash}', flush=True)
    print(f'Evidence: {root}', flush=True)
finally:
    server.shutdown()
    # Only the audit owns this temporary project, cache, proxy and venv.
    shutil.rmtree(root)
