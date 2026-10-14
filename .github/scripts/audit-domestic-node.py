import hashlib
import json
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
root = Path(tempfile.mkdtemp(prefix='crabot-cn-node-audit-'))
project = root / 'node 空'
project.mkdir()
(project / 'package.json').write_text(json.dumps({
    'name': 'crabot-native-source-audit', 'private': True, 'packageManager': 'pnpm@9.15.9',
    'dependencies': {'better-sqlite3': '12.9.0', 'sharp': '0.34.5'},
}))
hosts = []
class Proxy(http.server.BaseHTTPRequestHandler):
    def do_CONNECT(self):
        host, port = self.path.rsplit(':', 1)
        hosts.append(host)
        if not (host == 'registry.npmmirror.com' or host == 'cdn.npmmirror.com'):
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
env = {key: value for key, value in os.environ.items() if key.lower() not in ['https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'] and not key.startswith('COREPACK_')}
proxy_url = f'http://127.0.0.1:{server.server_port}'
env.update(HTTPS_PROXY=proxy_url, HTTP_PROXY=proxy_url, ALL_PROXY=proxy_url, NO_PROXY='localhost,127.0.0.1',
           COREPACK_HOME=str(root / 'corepack'), npm_config_store_dir=str(root / 'store'),
           XDG_CACHE_HOME=str(root / 'cache'), npm_config_cache=str(root / 'npm-cache'))
helper = repo / 'scripts/installer-deps.mjs'
def run(stage, args):
    result = subprocess.run(['node', *map(str, args)], cwd=project, env=env, text=True, capture_output=True, timeout=1200)
    if result.returncode:
        print(result.stdout + result.stderr, flush=True)
    assert result.returncode == 0, stage
    print(f'{stage}: exit=0', flush=True)
try:
    run('domestic-lock', [helper, 'pnpm', project, '-', 'install'])
    lock = project / 'pnpm-lock.yaml'
    before = hashlib.sha256(lock.read_bytes()).hexdigest()
    # First install creates a fixture lock; the acceptance run has no package/tool cache.
    for name in ['node_modules']:
        shutil.rmtree(project / name)
    for name in ['store', 'corepack', 'cache', 'npm-cache']:
        shutil.rmtree(root / name, ignore_errors=True)
    hosts.clear()
    run('cold-frozen-install', [helper, 'pnpm', project, '-', 'install', '--frozen-lockfile'])
    run('native-load', ['-e', "const db=new (require('better-sqlite3'))(':memory:');if(db.prepare('select 7 as n').get().n!==7)process.exit(1);db.close();require('sharp')({create:{width:1,height:1,channels:3,background:'red'}}).png().toBuffer().then(b=>{if(!b.length)process.exit(1)})"])
    prebuilds = list((root / 'npm-cache').rglob('*better-sqlite3*.tar.gz'))
    assert len(prebuilds) == 1, 'cold owned cache must contain the downloaded SQLite prebuild'
    print('SQLite downloaded prebuild: ' + prebuilds[0].name + '; SHA256=' + hashlib.sha256(prebuilds[0].read_bytes()).hexdigest(), flush=True)
    assert hashlib.sha256(lock.read_bytes()).hexdigest() == before
    assert 'registry.npmmirror.com' in hosts and 'cdn.npmmirror.com' in hosts, str(set(hosts))
    assert set(hosts) <= {'registry.npmmirror.com', 'cdn.npmmirror.com'}, str(set(hosts))
    print(f'Cold Corepack/pnpm/packages/SQLite prebuild/sharp: hosts={sorted(set(hosts))}, frozen lock={before}', flush=True)
finally:
    server.shutdown()
    shutil.rmtree(root)
