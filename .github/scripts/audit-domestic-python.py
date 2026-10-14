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
project = root / 'memory 空'
project.mkdir()
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
env['UV_PYTHON'] = sys.executable
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
    run('prod-frozen-offline', ['run', '--frozen', '--no-dev', '--offline', 'python', '-c', 'import src.main; print("memory import OK")'])
    baseline = run('existing-start-entry', ['run', '--frozen', '--offline', 'python', '-c', 'import src.main'], expected_success=False)
    assert 'pytest' in baseline.stderr, baseline.stderr
    assert hashlib.sha256((project / 'uv.lock').read_bytes()).hexdigest() == lock_hash
    assert hosts and set(hosts) == {'mirrors.aliyun.com'}, str(set(hosts))
    print('Actual Memory: cold domestic download, frozen hash/versions, production offline import OK', flush=True)
    print(f'HTTPS CONNECT hosts: {sorted(set(hosts))}; lock SHA256: {lock_hash}', flush=True)
    print(f'Evidence: {root}', flush=True)
finally:
    server.shutdown()
    # Only the audit owns this temporary project, cache, proxy and venv.
    shutil.rmtree(root)
